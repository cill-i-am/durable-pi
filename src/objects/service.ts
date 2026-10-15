import { Clock, Context, Effect, Layer, Schema } from "effect"
import {
  ChangeSource,
  ObjectFailure,
  ObjectId,
  ObjectMutation,
  OperationId,
  Revision,
  objectSummary,
  type ObjectEvent,
} from "./contracts"
import type { WorkingObjects } from "./objects"
import type { ObjectDigest, ObjectLedger } from "./ledger"
import { changeChecklist } from "./checklist"
import {
  objectEventId,
  objectOfferedThrough,
  objectReplay,
  requireObjectCapacity,
  requireObjectCancellationCapacity,
  requireObjectWritable,
} from "./domain"

export class Objects extends Context.Service<Objects, WorkingObjects>()(
  "durable-pi/objects/Objects"
) {}
const decode = <T>(schema: Schema.ConstraintDecoder<T>, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError(
      () =>
        new ObjectFailure({
          code: "invalid",
          message: "Check the checklist fields, IDs, dates and revision.",
        })
    )
  )
const decision = <T>(body: () => T) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      const objectFailure = Schema.decodeUnknownOption(ObjectFailure)(cause)
      if (objectFailure._tag === "Some") return objectFailure.value
      throw cause
    },
  })

export function makeWorkingObjects(
  ledger: ObjectLedger,
  canWrite: (source: ChangeSource) => boolean,
  digest: ObjectDigest
): WorkingObjects {
  const writable = (source: ChangeSource) =>
    requireObjectWritable(canWrite, source)
  const context = Effect.fn("Objects.context")(() =>
    ledger.atomic((tx) =>
      Effect.gen(function* () {
        const catalog = yield* tx.catalog()
        const objects = []
        for (const id of catalog.ids) {
          const stored = yield* tx.checklist(id)
          if (stored.value) objects.push(objectSummary(stored.value))
        }
        return {
          sequence: catalog.sequence,
          offeredThrough: catalog.offeredThrough,
          objects,
        }
      })
    )
  )
  return {
    context,
    list: Effect.fn("Objects.list")(() =>
      context().pipe(Effect.map((snapshot) => snapshot.objects))
    ),
    read: Effect.fn("Objects.read")(function* (raw, before) {
      const id = yield* decode(ObjectId, raw)
      if (before !== undefined) yield* decode(Revision, before)
      const object = yield* ledger.checklist(id)
      if (!object)
        return yield* new ObjectFailure({
          code: "not_found",
          message: "This checklist is unavailable in this bot.",
        })
      const from = Math.min(
        object.revision,
        before === undefined ? object.revision : before - 1
      )
      const events: ObjectEvent[] = []
      for (let revision = from; revision > Math.max(0, from - 20); revision--) {
        const event = yield* ledger.event(objectEventId(id, revision))
        if (event) events.push(event)
      }
      return { object, events, nextHistory: from > 20 ? from - 19 : null }
    }),
    mutate: Effect.fn("Objects.mutate")(function* (raw, origin) {
      const input = yield* decode(ObjectMutation, raw)
      const source = yield* decode(ChangeSource, origin)
      const fingerprint = yield* digest({ input, source })
      return yield* ledger.atomic((tx) =>
        Effect.gen(function* () {
          yield* decision(() => writable(source))
          const operation = yield* tx.operation(input.operationId)
          const replay = yield* decision(() =>
            objectReplay(operation, fingerprint)
          )
          if (replay) return replay
          const catalog = yield* tx.catalog()
          const stored = yield* tx.checklist(input.id)
          yield* decision(() =>
            requireObjectCapacity(
              catalog.operations,
              catalog.ids.length,
              !stored.value
            )
          )
          const now = yield* Clock.currentTimeMillis
          const { value, changes } = yield* decision(() =>
            changeChecklist(
              stored.value ?? undefined,
              input,
              source,
              new Date(now).toISOString(),
              catalog.sequence + 1
            )
          )
          const id = objectEventId(value.id, value.revision)
          const event = changes.length ? yield* tx.event(id) : null
          // All native document reads finish before the final authority check and
          // synchronous publication into the single commit's mutable views.
          return yield* decision(() => {
            writable(source)
            if (event) {
              event.value = {
                id,
                objectId: value.id,
                revision: value.revision,
                sequence: value.lastEvent,
                source,
                at: value.updatedAt,
                changes,
              }
              catalog.sequence = value.lastEvent
            }
            if (!stored.value) catalog.ids.push(value.id)
            stored.value = { ...value, tasks: [...value.tasks] }
            catalog.operations++
            const receipt = {
              objectId: value.id,
              revision: value.revision,
              eventId: id,
            }
            operation.digest = fingerprint
            operation.receipt = receipt
            return receipt
          })
        })
      )
    }),
    cancel: Effect.fn("Objects.cancel")(function* (raw) {
      const id = yield* decode(OperationId, raw)
      return yield* ledger.atomic((tx) =>
        Effect.gen(function* () {
          const source: ChangeSource = {
            actor: "user",
            surface: "workbench",
            turnId: null,
            toolCallId: null,
          }
          yield* decision(() => writable(source))
          const operation = yield* tx.operation(id)
          const catalog = yield* tx.catalog()
          if (operation.receipt) return { applied: true }
          return yield* decision(() => {
            if (!operation.cancelled) {
              requireObjectCancellationCapacity(catalog.operations)
              writable(source)
              operation.cancelled = true
              catalog.operations++
            }
            return { applied: false }
          })
        })
      )
    }),
    offered: Effect.fn("Objects.offered")(function* (sequence) {
      yield* decode(Revision, sequence)
      yield* ledger.atomic((tx) =>
        tx.catalog().pipe(
          Effect.map((catalog) => {
            catalog.offeredThrough = objectOfferedThrough(
              catalog.offeredThrough,
              sequence,
              catalog.sequence
            )
          })
        )
      )
    }),
  }
}
export const objectApplication = (
  ledger: ObjectLedger,
  canWrite: (source: ChangeSource) => boolean,
  digest: ObjectDigest
) => Layer.succeed(Objects, makeWorkingObjects(ledger, canWrite, digest))
