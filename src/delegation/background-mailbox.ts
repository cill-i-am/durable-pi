import { Clock, Context, Effect, Schema } from "effect"

import { type ConversationFailure } from "../conversations/turns"
import { BackgroundHandoff } from "./background"
import * as Domain from "./background-domain"
import {
  advanceBackgroundHandoff,
  newBackgroundHandoff,
} from "./background-handoff.machine"
import {
  BackgroundStorageError,
  type BackgroundLedger,
} from "./background-ledger"
import { advanceBackgroundStop } from "./background-stop.machine"
import { DelegationFailure, type DelegateInput, type Group } from "./contracts"
import { DURATION_MS, type DelegationSource } from "./delegation"

export type BackgroundError =
  | DelegationFailure
  | BackgroundStorageError
  | ConversationFailure
export interface BackgroundAdmission {
  readonly transactionGroup: object
  readonly admit: (
    handoff: BackgroundHandoff,
    report: string
  ) => Effect.Effect<string, ConversationFailure>
  readonly stop: (reportId: string) => Effect.Effect<void, ConversationFailure>
}
export type BackgroundMailboxService = ReturnType<typeof makeBackgroundMailbox>
export class BackgroundMailbox extends Context.Service<
  BackgroundMailbox,
  BackgroundMailboxService
>()("durable-pi/delegation/BackgroundMailbox") {}

const attempt = <T>(body: () => T) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      const knownFailure = Schema.decodeUnknownOption(
        Schema.Union([DelegationFailure, BackgroundStorageError])
      )(cause)
      if (knownFailure._tag === "Some") return knownFailure.value
      throw cause
    },
  })

export function makeBackgroundMailbox(
  records: BackgroundLedger,
  authority: (
    turnId: string
  ) => Effect.Effect<Domain.BackgroundAuthority, ConversationFailure>,
  parentObject: string,
  uuid: () => string,
  now: Effect.Effect<number> = Clock.currentTimeMillis
) {
  const shared = (admission: BackgroundAdmission) =>
    Effect.sync(() => {
      if (admission.transactionGroup !== records.transactionGroup)
        throw new Error(
          "Background admission must share its storage transaction group."
        )
    })
  const cancelled = (row: Domain.Handoff, at: number, explicit = false) =>
    advanceBackgroundStop(advanceBackgroundHandoff(row, { type: "CANCEL" }), {
      type: "REQUEST",
      now: at,
      explicit,
    })
  const persist = (before: Domain.Handoff, next: Domain.Handoff) =>
    next.revision === before.revision ? Effect.void : records.put(next)
  return {
    get: Effect.fn("BackgroundMailbox.get")((id: number) => records.get(id)),
    list: Effect.fn("BackgroundMailbox.list")((offset: number = 0) =>
      records.list(offset)
    ),
    create: Effect.fn("BackgroundMailbox.create")(function* (
      input: DelegateInput,
      source: DelegationSource,
      discoveryDeadline: number
    ) {
      const at = yield* now
      return yield* records.atomic(() =>
        Effect.gen(function* () {
          const prior = yield* records.get(source.taskId)
          if (prior) {
            if (
              prior.turn_id !== source.turnId ||
              prior.handoff.conversationId !== source.conversationId ||
              prior.handoff.parentObject !== parentObject ||
              JSON.stringify(prior.handoff.input) !== JSON.stringify(input)
            )
              return yield* Domain.backgroundRejected(
                "conflict",
                "This background task identity belongs to a different request."
              )
            return prior
          }
          if ((yield* authority(source.turnId)) !== "active")
            return yield* Domain.backgroundRejected(
              "cancelled",
              "This request has stopped."
            )
          if (yield* records.hasTurn(source.turnId))
            return yield* Domain.backgroundRejected(
              "limit",
              "This request already started a background group."
            )
          if (
            (yield* records.unfinished()).filter(
              (row) => row.status !== "cancelled" && row.status !== "delivered"
            ).length >= 2
          )
            return yield* Domain.backgroundRejected(
              "limit",
              "This bot already has two unfinished background groups. Inspect or stop those first."
            )
          if (
            !Number.isFinite(discoveryDeadline) ||
            (yield* now) >= discoveryDeadline
          )
            return yield* Domain.backgroundRejected(
              "unavailable",
              "Background recovery lease expired before acceptance."
            )
          const handoff = Schema.decodeUnknownSync(BackgroundHandoff)({
            ...source,
            id: source.taskId,
            parentObject,
            input,
            reportId: uuid(),
            createdAt: at,
            deadline: at + DURATION_MS,
          })
          const row = newBackgroundHandoff({
            id: handoff.id,
            turn_id: handoff.turnId,
            handoff,
            report: null,
            error: null,
            failures: 0,
            next_at: at,
            schema_version: 1,
            workflow_version: 1,
            revision: 0,
            stop_state: "none",
            stop_attempt: null,
            stop_attempts: 0,
            stop_next_at: null,
            stop_deadline: null,
            stop_error: null,
          })
          yield* records.put(row)
          return row
        })
      )
    }),
    authorized: Effect.fn("BackgroundMailbox.authorized")(function* (
      id: number
    ) {
      const row = yield* records.get(id),
        permission = row ? yield* authority(row.turn_id) : "cancelled",
        at = yield* now
      return yield* attempt(() => Domain.authorizedHandoff(row, permission, at))
    }),
    cancel: Effect.fn("BackgroundMailbox.cancel")(
      (
        id: number,
        admission: BackgroundAdmission | undefined,
        discoveryDeadline: number
      ) =>
        records.atomic(() =>
          Effect.gen(function* () {
            if (admission) yield* shared(admission)
            const saved = yield* records.get(id),
              row = yield* attempt(() => Domain.requireHandoff(saved)),
              at = yield* now
            if (!Number.isFinite(discoveryDeadline) || at >= discoveryDeadline)
              return yield* Domain.backgroundRejected(
                "unavailable",
                "Background recovery lease expired before Stop acceptance."
              )
            const next = cancelled(row, at, true)
            yield* persist(row, next)
            if (admission) yield* admission.stop(row.handoff.reportId)
          })
        )
    ),
    due: Effect.fn("BackgroundMailbox.due")(function* () {
      const at = yield* now
      return (yield* records.unfinished())
        .filter(
          (row) =>
            Domain.polling(row) && row.next_at !== null && row.next_at <= at
        )
        .slice(0, 2)
    }),
    reconcileCancellation: Effect.fn("BackgroundMailbox.reconcileCancellation")(
      function* (revoked = false) {
        return yield* records.atomic(() =>
          Effect.gen(function* () {
            for (const row of yield* records.unfinished()) {
              const permission = revoked
                  ? "cancelled"
                  : yield* authority(row.turn_id),
                at = yield* now
              const next = advanceBackgroundHandoff(row, {
                type: "EXPIRE",
                authority: permission,
                now: at,
              })
              yield* persist(
                row,
                next.status === "cancelled" && row.status !== "cancelled"
                  ? advanceBackgroundStop(next, {
                      type: "REQUEST",
                      now: at,
                      explicit: false,
                    })
                  : next
              )
            }
            const at = yield* now
            return (yield* records.unfinished()).filter(
              (row) =>
                row.stop_state === "pending" &&
                row.stop_next_at !== null &&
                row.stop_next_at <= at
            )
          })
        )
      }
    ),
    observed: Effect.fn("BackgroundMailbox.observed")(function* (
      id: number,
      group: Group,
      revision?: number
    ) {
      yield* records.atomic(() =>
        Effect.gen(function* () {
          const row = yield* records.get(id)
          if (row) {
            const permission = yield* authority(row.turn_id),
              at = yield* now
            const next = yield* attempt(() =>
              advanceBackgroundHandoff(row, {
                type: "OBSERVED",
                group,
                authority: permission,
                now: at,
                revision: revision ?? row.revision,
              })
            )
            yield* persist(
              row,
              next.status === "cancelled" && row.status !== "cancelled"
                ? advanceBackgroundStop(next, {
                    type: "REQUEST",
                    now: at,
                    explicit: false,
                  })
                : next
            )
          }
        })
      )
    }),
    failed: Effect.fn("BackgroundMailbox.failed")(function* (
      id: number,
      revision?: number
    ) {
      yield* records.atomic(() =>
        Effect.gen(function* () {
          const row = yield* records.get(id)
          if (row) {
            const permission = yield* authority(row.turn_id),
              at = yield* now
            const next = advanceBackgroundHandoff(row, {
              type: "FAILED",
              authority: permission,
              now: at,
              revision: revision ?? row.revision,
            })
            yield* persist(
              row,
              next.status === "cancelled" && row.status !== "cancelled"
                ? advanceBackgroundStop(next, {
                    type: "REQUEST",
                    now: at,
                    explicit: false,
                  })
                : next
            )
          }
        })
      )
    }),
    retry: Effect.fn("BackgroundMailbox.retry")(function* (
      id: number,
      operationId: string,
      discoveryDeadline: number
    ) {
      return yield* records.atomic(() =>
        Effect.gen(function* () {
          const prior = yield* records.retry(operationId)
          if (prior !== undefined) {
            if (prior !== id)
              return yield* Domain.backgroundRejected(
                "conflict",
                "This retry belongs to another group."
              )
            return false
          }
          const saved = yield* records.get(id),
            row = yield* attempt(() => Domain.requireHandoff(saved))
          const permission = yield* authority(row.turn_id),
            at = yield* now
          if (!Number.isFinite(discoveryDeadline) || at >= discoveryDeadline)
            return yield* Domain.backgroundRejected(
              "unavailable",
              "Background recovery lease expired before retry acceptance."
            )
          const next = advanceBackgroundHandoff(row, {
            type: "RETRY",
            authority: permission,
            now: at,
          })
          if (next.revision === row.revision)
            return yield* Domain.backgroundRejected(
              "cancelled",
              "This group cannot resume."
            )
          yield* records.putRetry(operationId, id)
          yield* records.put(next)
          return true
        })
      )
    }),
    deliver: Effect.fn("BackgroundMailbox.deliver")(
      (admission: BackgroundAdmission) =>
        records.atomic(() =>
          Effect.gen(function* () {
            yield* shared(admission)
            const row = (yield* records.unfinished()).find(
              (item) => item.status === "ready"
            )
            if (!row) return false
            const parent = yield* authority(row.turn_id)
            const next = advanceBackgroundHandoff(row, {
              type: "DELIVER",
              authority: parent,
            })
            if (next.status === "cancelled") {
              yield* records.put(
                advanceBackgroundStop(next, {
                  type: "REQUEST",
                  now: yield* now,
                  explicit: false,
                })
              )
              return false
            }
            if (next.status !== "delivered") return false
            if (row.report === null)
              throw new Error("Ready background handoff has no report.")
            if (
              (yield* admission.admit(row.handoff, row.report)) !==
              row.handoff.reportId
            )
              throw new Error(
                "Background admission returned a different turn identity."
              )
            yield* records.put(next)
            return true
          })
        )
    ),
    claimStop: Effect.fn("BackgroundMailbox.claimStop")(function* (id: number) {
      return yield* records.atomic(() =>
        Effect.gen(function* () {
          const row = yield* records.get(id)
          if (!row) return undefined
          const attemptId = uuid()
          const next = advanceBackgroundStop(row, {
            type: "CLAIM",
            now: yield* now,
            attempt: attemptId,
          })
          yield* persist(row, next)
          return next.stop_state === "pending" &&
            next.stop_attempt === attemptId
            ? next
            : undefined
        })
      )
    }),
    stopped: Effect.fn("BackgroundMailbox.stopped")(function* (
      id: number,
      attemptId: string,
      acknowledged: boolean
    ) {
      yield* records.atomic(() =>
        Effect.gen(function* () {
          const row = yield* records.get(id)
          if (!row) return
          const next = advanceBackgroundStop(
            row,
            acknowledged
              ? { type: "ACKNOWLEDGED", attempt: attemptId }
              : { type: "UNAVAILABLE", attempt: attemptId, now: yield* now }
          )
          yield* persist(row, next)
        })
      )
    }),
    exhaustRecovery: Effect.fn("BackgroundMailbox.exhaustRecovery")(
      (current: () => boolean) =>
        records.atomic(() =>
          Effect.gen(function* () {
            const at = yield* now
            if (!current()) return
            for (const row of yield* records.unfinished()) {
              if (!current()) return
              const next = advanceBackgroundStop(
                advanceBackgroundHandoff(row, { type: "EXHAUSTED", now: at }),
                { type: "EXHAUSTED", now: at }
              )
              yield* persist(row, next)
            }
          })
        )
    ),
    nextWake: Effect.fn("BackgroundMailbox.nextWake")(() =>
      records.unfinished().pipe(
        Effect.map((rows) => {
          const times = rows.flatMap((row) => [
            ...(row.status === "paused"
              ? [row.handoff.deadline]
              : Domain.polling(row) && row.next_at !== null
                ? [row.next_at]
                : []),
            ...(row.stop_state === "pending" && row.stop_next_at !== null
              ? [row.stop_next_at]
              : []),
          ])
          return times.length ? Math.min(...times) : undefined
        })
      )
    ),
  }
}
