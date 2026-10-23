import { createEffectActor, waitFor } from "@xstate/effect"
import { Cause, Clock, Crypto, Equal, Effect, Exit, Schema } from "effect"

import { fatalCause } from "../shared/effect"
import {
  BackupManifest,
  backupPublicationMachine,
  sameBackupWatermark as same,
} from "./backup-publication.machine"
import { BackupFailure, BackupStore } from "./backup-store"
import { sha256 } from "./checksum"
import { advance, ArchiveRecord, emptyWatermark } from "./records"
import { MemoryRepository } from "./repository"

const BatchSchema = Schema.Struct({
  version: Schema.Literal(1),
  previous: Schema.NullOr(Schema.String),
  records: Schema.Array(ArchiveRecord),
})
const decodeManifest = (text: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(BackupManifest))(text).pipe(
    Effect.mapError(
      () =>
        new BackupFailure({
          reason: "invalid",
          message: "Invalid backup manifest",
        })
    )
  )
const decodeBatch = (text: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(BatchSchema))(text).pipe(
    Effect.mapError(
      () =>
        new BackupFailure({
          reason: "invalid",
          message: "Invalid backup batch",
        })
    )
  )
/** The actor scope must join both parallel writes before exposing completion.
 * Preserve late cleanup Causes from invocations stopped by alpha.8. */
export const backupMemory = Effect.fn("Memory.backup")(function* (
  prefix: string
) {
  const memory = yield* MemoryRepository,
    bucket = yield* BackupStore
  const crypto = yield* Crypto.Crypto
  const digest = (data: string) =>
    sha256(data).pipe(Effect.provideService(Crypto.Crypto, crypto))
  const failures: Cause.Cause<unknown>[] = []
  const observe = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (Exit.isFailure(exit)) failures.push(exit.cause)
        })
      )
    )
  const machine = backupPublicationMachine({
    load: observe(
      Effect.gen(function* () {
        const [object, latest] = yield* Effect.all(
          [
            bucket.get(`${prefix}/progress.json`),
            bucket.get(`${prefix}/latest.json`),
          ],
          { concurrency: 2 }
        )
        const prior = object ? yield* decodeManifest(object.text) : null
        const published = latest ? yield* decodeManifest(latest.text) : null
        const { until, parts } = yield* memory.snapshot()
        if (
          [prior, published].some(
            (manifest) =>
              manifest !== null &&
              (manifest.until.messages > until.messages ||
                manifest.until.nodes > until.nodes ||
                manifest.until.notes > until.notes)
          )
        )
          return yield* new BackupFailure({
            reason: "ahead",
            message: "Backup is ahead of local memory; recovery is required",
          })
        return {
          prior,
          checkpointEtag: object?.etag ?? null,
          latest: published,
          latestEtag: latest?.etag ?? null,
          until,
          parts,
        }
      })
    ),
    page: (observation, cursor) =>
      observe(memory.archivePage(cursor.after, observation.until)),
    batch: (cursor, records) =>
      observe(
        Effect.gen(function* () {
          const data = JSON.stringify({
            version: 1,
            previous: cursor.head,
            records,
          })
          const key = `${prefix}/batches/${yield* digest(data)}.json`
          yield* bucket.put(key, data)
          return key
        })
      ),
    manifest: (observation, cursor, complete) =>
      observe(
        Effect.gen(function* () {
          // A restart after checkpoint must reuse the immutable publication identity.
          if (
            complete &&
            observation.prior &&
            same(observation.prior.until, observation.until) &&
            JSON.stringify(observation.prior.parts) ===
              JSON.stringify(observation.parts)
          )
            return observation.prior
          return {
            version: 1 as const,
            head: cursor.head,
            until: cursor.after,
            parts: complete
              ? observation.parts
              : (observation.prior?.parts ?? []),
            date: new Date(yield* Clock.currentTimeMillis).toISOString(),
          }
        })
      ),
    checkpoint: (observation, manifest, complete) =>
      observe(
        Effect.gen(function* () {
          const data = JSON.stringify(manifest)
          const checkpoint =
            observation.prior === manifest
              ? Effect.void
              : bucket.put(
                  `${prefix}/progress.json`,
                  data,
                  observation.checkpointEtag === null
                    ? { absent: true }
                    : { etag: observation.checkpointEtag }
                )
          if (complete)
            yield* Effect.all(
              [
                checkpoint,
                bucket.put(
                  `${prefix}/snapshots/${yield* digest(data)}.json`,
                  data
                ),
              ],
              { concurrency: 2 }
            )
          else yield* checkpoint
        })
      ),
    publish: (observation, manifest) =>
      observe(
        JSON.stringify(observation.latest) === JSON.stringify(manifest)
          ? Effect.void
          : bucket.put(
              `${prefix}/latest.json`,
              JSON.stringify(manifest),
              observation.latestEtag === null
                ? { absent: true }
                : { etag: observation.latestEtag }
            )
      ),
  })
  return yield* Effect.gen(function* () {
    const actor = yield* createEffectActor(machine)
    const done = yield* waitFor(
      actor,
      (snapshot) => snapshot.status === "done"
    ).pipe(Effect.orDie)
    return yield* done.output!
  }).pipe(
    Effect.scoped,
    Effect.onExit((exit) => {
      if (!Exit.isFailure(exit) || !Cause.hasInterrupts(exit.cause))
        return Effect.void
      const reasons = failures
        .flatMap((cause) => cause.reasons)
        .filter(
          (reason) =>
            reason._tag !== "Interrupt" &&
            !exit.cause.reasons.some((present) => Equal.equals(present, reason))
        )
      return reasons.length
        ? Effect.failCause(fatalCause(Cause.fromReasons(reasons)))
        : Effect.void
    })
  )
})

export const readBackup = Effect.fn("Memory.readBackup")(function* (
  prefix: string
) {
  const bucket = yield* BackupStore
  const object = yield* bucket.get(`${prefix}/latest.json`)
  if (!object)
    return yield* new BackupFailure({
      reason: "missing",
      message: "No backup exists",
    })
  const manifest = yield* decodeManifest(object.text)
  const seen = new Set<string>(),
    batches: ArchiveRecord[][] = []
  let key = manifest.head
  while (key) {
    if (!key.startsWith(`${prefix}/batches/`) || seen.has(key))
      return yield* new BackupFailure({
        reason: "invalid",
        message: "Invalid backup chain",
      })
    seen.add(key)
    const batchObject = yield* bucket.get(key)
    if (!batchObject)
      return yield* new BackupFailure({
        reason: "invalid",
        message: "Missing backup batch",
      })
    const text = batchObject.text
    if (key !== `${prefix}/batches/${yield* sha256(text)}.json`)
      return yield* new BackupFailure({
        reason: "invalid",
        message: "Backup checksum mismatch",
      })
    const batch = yield* decodeBatch(text)
    batches.push([...batch.records])
    key = batch.previous
  }
  const records = batches.reverse().flat()
  if (!same(advance(emptyWatermark, records), manifest.until))
    return yield* new BackupFailure({
      reason: "invalid",
      message: "Incomplete backup",
    })
  return { records, parts: [...manifest.parts], until: manifest.until }
})
