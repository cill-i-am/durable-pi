import { Effect, Schema } from "effect"

import { RoutineConflict } from "../routines/contracts"
import type { RoutineAdmissionState } from "../routines/service"
import {
  WebhookRejected,
  type ConfigureWebhook,
  type WebhookInfo,
  WebhookInfo as InfoSchema,
  reject,
} from "./contracts"
import type { WebhookPersistence, WebhookStorageError } from "./persistence"

const decision = <TValue>(body: () => TValue) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      const known = Schema.decodeUnknownOption(WebhookRejected)(cause)
      if (known._tag === "Some") return known.value
      throw cause
    },
  })
const routineFailure = <TValue, TError, TRequirements>(
  effect: Effect.Effect<TValue, TError, TRequirements>
) =>
  effect.pipe(
    Effect.mapError((error) =>
      Schema.is(RoutineConflict)(error)
        ? new WebhookRejected({ reason: "conflict", message: error.message })
        : (error as Exclude<TError, RoutineConflict>)
    )
  )
export class WebhookTransactions {
  constructor(
    private readonly records: WebhookPersistence["Service"],
    private readonly routines: RoutineAdmissionState["Service"],
    private readonly active: () => Effect.Effect<boolean, WebhookStorageError>
  ) {
    if (records.transactionGroup !== routines.transactionGroup)
      throw new Error(
        "Webhook receipts and routine runs must share a storage transaction group."
      )
  }
  info(id: string) {
    return this.records.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const row = yield* this.records.key(id)
        return {
          routineId: id,
          enabled: !!row?.hash,
          revision: row?.revision ?? 0,
          accepted: yield* this.records.eventCount(id),
        } satisfies WebhookInfo
      })
    )
  }
  configure(input: Omit<ConfigureWebhook, "key"> & { hash: string | null }) {
    return routineFailure(
      this.records.atomic(() =>
        Effect.gen({ self: this }, function* () {
          if (!(yield* this.active()))
            return yield* decision(() =>
              reject(
                "conflict",
                "Restore this bot before changing its webhook."
              )
            )
          const routine = yield* this.routines.get(input.routineId)
          if (!routine || routine.status === "archived")
            return yield* decision(() =>
              reject(
                "conflict",
                "Restore this routine before changing its webhook."
              )
            )
          const previous = yield* this.records.operation(input.operationId)
          if (previous) {
            if (previous.input !== JSON.stringify(input))
              return yield* decision(() =>
                reject(
                  "conflict",
                  "This request was cancelled or belongs to another change."
                )
              )
            return Schema.decodeUnknownSync(InfoSchema)(
              JSON.parse(previous.result)
            )
          }
          if ((yield* this.records.operationCount()) >= 2000)
            return yield* decision(() =>
              reject("conflict", "This bot reached its webhook change limit.")
            )
          const current = yield* this.records.key(input.routineId)
          if ((current?.revision ?? 0) !== input.expectedRevision)
            return yield* decision(() =>
              reject(
                "conflict",
                "The webhook changed. Resolve this request and reload before changing it."
              )
            )
          yield* this.records.putKey(input.routineId, {
            revision: input.expectedRevision + 1,
            hash: input.hash,
          })
          const pending = yield* this.routines.inFlight()
          if (
            pending?.routineId === input.routineId &&
            pending.trigger === "webhook" &&
            pending.status === "pending"
          )
            yield* this.routines.cancelPendingRun(pending.id)
          const info = yield* this.info(input.routineId)
          yield* this.records.putOperation(input.operationId, {
            input: JSON.stringify(input),
            result: JSON.stringify(info),
          })
          return info
        })
      )
    )
  }
  cancel(operationId: string) {
    return this.records.atomic(() =>
      Effect.gen({ self: this }, function* () {
        if (!(yield* this.active()))
          return yield* decision(() =>
            reject("conflict", "Restore this bot first.")
          )
        const previous = yield* this.records.operation(operationId)
        if (previous) return { applied: previous.input !== "cancelled" }
        if ((yield* this.records.operationCount()) >= 2000)
          return yield* decision(() =>
            reject("conflict", "This bot reached its webhook change limit.")
          )
        yield* this.records.putOperation(operationId, {
          input: "cancelled",
          result: "null",
        })
        return { applied: false }
      })
    )
  }
  authorized(id: string, hash: string) {
    return Effect.gen({ self: this }, function* () {
      const key = yield* this.records.key(id)
      const expected = key?.hash ?? "0".repeat(64)
      let diff = expected.length ^ hash.length
      for (let i = 0; i < 64; i++)
        diff |= expected.charCodeAt(i) ^ (hash.charCodeAt(i) || 0)
      return !!key?.hash && diff === 0 && (yield* this.active())
    })
  }
  accept(
    id: string,
    keyHash: string,
    eventId: string,
    payload: string,
    payloadHash: string
  ) {
    return routineFailure(
      this.records.atomic(() =>
        Effect.gen({ self: this }, function* () {
          if (!(yield* this.authorized(id, keyHash)))
            return yield* decision(() =>
              reject("unauthorized", "Invalid webhook authorization.")
            )
          const previous = yield* this.records.event(id, eventId)
          if (previous) {
            if (previous.hash !== payloadHash)
              return yield* decision(() =>
                reject(
                  "conflict",
                  "This event ID already belongs to different data."
                )
              )
            return { runId: previous.run_id, duplicate: true }
          }
          if ((yield* this.routines.get(id))?.status !== "active")
            return yield* decision(() =>
              reject("conflict", "This routine is paused or unavailable.")
            )
          if (yield* this.routines.inFlight())
            return yield* decision(() =>
              reject(
                "busy",
                "This bot already has a routine waiting or running. Retry this event later."
              )
            )
          if ((yield* this.records.eventCount()) >= 2000)
            return yield* decision(() =>
              reject("conflict", "This bot reached its webhook event limit.")
            )
          const run = yield* this.routines.acceptWebhook(id, payload)
          yield* this.records.putEvent(id, eventId, {
            hash: payloadHash,
            run_id: run.id,
          })
          return { runId: run.id, duplicate: false }
        })
      )
    )
  }
}
