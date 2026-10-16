import { Clock, Context, Effect, Schema } from "effect"
import { type ConversationFailure } from "../conversations/turns"
import { BackgroundHandoff } from "./background"
import { DelegationFailure, type DelegateInput, type Group } from "./contracts"
import { DURATION_MS, type DelegationSource } from "./delegation"
import {
  BackgroundStorageError,
  type BackgroundLedger,
} from "./background-ledger"
import * as Domain from "./background-domain"

export type BackgroundError =
  DelegationFailure | BackgroundStorageError | ConversationFailure
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
  return {
    get: Effect.fn("BackgroundMailbox.get")((id: number) => records.get(id)),
    list: Effect.fn("BackgroundMailbox.list")((offset = 0) =>
      records.list(offset)
    ),
    create: Effect.fn("BackgroundMailbox.create")(function* (
      input: DelegateInput,
      source: DelegationSource
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
          if ((yield* records.unfinished()).length >= 2)
            return yield* Domain.backgroundRejected(
              "limit",
              "This bot already has two unfinished background groups. Inspect or stop those first."
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
          const row: Domain.Handoff = {
            id: handoff.id,
            turn_id: handoff.turnId,
            handoff,
            status: "pending",
            report: null,
            error: null,
            failures: 0,
            next_at: at,
          }
          yield* records.put(row)
          return row
        })
      )
    }),
    authorized: Effect.fn("BackgroundMailbox.authorized")(function* (
      id: number
    ) {
      const at = yield* now,
        row = yield* records.get(id),
        permission = row ? yield* authority(row.turn_id) : "cancelled"
      return yield* attempt(() => Domain.authorizedHandoff(row, permission, at))
    }),
    cancel: Effect.fn("BackgroundMailbox.cancel")(
      (id: number, admission?: BackgroundAdmission) =>
        records.atomic(() =>
          Effect.gen(function* () {
            if (admission) yield* shared(admission)
            const saved = yield* records.get(id),
              row = yield* attempt(() => Domain.requireHandoff(saved)),
              next = Domain.cancelledHandoff(row)
            if (next !== row) yield* records.put(next)
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
      function* () {
        const at = yield* now
        return yield* records.atomic(() =>
          Effect.gen(function* () {
            const cancelled: Domain.Handoff[] = []
            for (const row of yield* records.unfinished())
              if (
                Domain.expiredHandoff(row, yield* authority(row.turn_id), at)
              ) {
                cancelled.push(row)
                yield* records.put(Domain.cancelledHandoff(row))
              }
            return cancelled
          })
        )
      }
    ),
    observed: Effect.fn("BackgroundMailbox.observed")(function* (
      id: number,
      group: Group
    ) {
      const at = yield* now
      yield* records.atomic(() =>
        Effect.gen(function* () {
          const row = yield* records.get(id)
          if (row) {
            const permission = yield* authority(row.turn_id)
            const next = yield* attempt(() =>
              Domain.observeHandoff(row, group, permission, at)
            )
            if (next !== row) yield* records.put(next)
          }
        })
      )
    }),
    failed: Effect.fn("BackgroundMailbox.failed")(function* (id: number) {
      const at = yield* now
      yield* records.atomic(() =>
        Effect.gen(function* () {
          const row = yield* records.get(id)
          if (row) {
            const next = Domain.expiredHandoff(
              row,
              yield* authority(row.turn_id),
              at
            )
              ? Domain.cancelledHandoff(row)
              : Domain.failedHandoff(row, at)
            if (next !== row) yield* records.put(next)
          }
        })
      )
    }),
    retry: Effect.fn("BackgroundMailbox.retry")(function* (
      id: number,
      operationId: string
    ) {
      const at = yield* now
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
          if (
            row.status !== "paused" ||
            (yield* authority(row.turn_id)) === "cancelled" ||
            at >= row.handoff.deadline
          )
            return yield* Domain.backgroundRejected(
              "cancelled",
              "This group cannot resume."
            )
          yield* records.putRetry(operationId, id)
          yield* records.put({
            ...row,
            status: "pending",
            failures: 0,
            error: null,
            next_at: at,
          })
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
            if (parent === "cancelled") {
              yield* records.put(Domain.cancelledHandoff(row))
              return false
            }
            if (parent !== "done") return false
            if (row.report === null)
              throw new Error("Ready background handoff has no report.")
            if (
              (yield* admission.admit(row.handoff, row.report)) !==
              row.handoff.reportId
            )
              throw new Error(
                "Background admission returned a different turn identity."
              )
            yield* records.put({ ...row, status: "delivered" })
            return true
          })
        )
    ),
    nextWake: Effect.fn("BackgroundMailbox.nextWake")(() =>
      records.unfinished().pipe(
        Effect.map((rows) => {
          const times = rows.flatMap((row) =>
            row.status === "paused"
              ? [row.handoff.deadline]
              : Domain.polling(row) && row.next_at !== null
                ? [row.next_at]
                : []
          )
          return times.length ? Math.min(...times) : undefined
        })
      )
    ),
  }
}
