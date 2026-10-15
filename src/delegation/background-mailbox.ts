import { Clock, Context, Effect, Schema } from "effect"
import {
  conversationFailure,
  type ConversationFailure,
} from "../conversations/turns"
import { BackgroundHandoff } from "./background"
import { DelegationFailure, type DelegateInput, type Group } from "./contracts"
import { DURATION_MS, type DelegationSource } from "./delegation"
import {
  BackgroundStorageError,
  type BackgroundLedger,
} from "./background-ledger"
import * as Domain from "./background-domain"

export type BackgroundError = DelegationFailure | BackgroundStorageError
export interface BackgroundAdmission {
  readonly transactionGroup: object
  readonly admit: (handoff: BackgroundHandoff, report: string) => string
  readonly stop: (reportId: string) => void
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
  authority: (turnId: string) => Domain.BackgroundAuthority,
  parentObject: string,
  uuid: () => string,
  now: Effect.Effect<number> = Clock.currentTimeMillis
) {
  const shared = (admission: BackgroundAdmission) => {
    if (admission.transactionGroup !== records.transactionGroup)
      throw new Error(
        "Background admission must share its storage transaction group."
      )
  }
  return {
    get: Effect.fn("BackgroundMailbox.get")((id: number) =>
      attempt(() => records.get(id))
    ),
    list: Effect.fn("BackgroundMailbox.list")((offset = 0) =>
      attempt(() => records.list(offset))
    ),
    create: Effect.fn("BackgroundMailbox.create")(function* (
      input: DelegateInput,
      source: DelegationSource
    ) {
      const at = yield* now
      return yield* attempt(() =>
        records.atomic(() => {
          const prior = records.get(source.taskId)
          if (prior) {
            if (
              prior.turn_id !== source.turnId ||
              prior.handoff.conversationId !== source.conversationId ||
              prior.handoff.parentObject !== parentObject ||
              JSON.stringify(prior.handoff.input) !== JSON.stringify(input)
            )
              throw Domain.backgroundRejected(
                "conflict",
                "This background task identity belongs to a different request."
              )
            return prior
          }
          if (authority(source.turnId) !== "active")
            throw Domain.backgroundRejected(
              "cancelled",
              "This request has stopped."
            )
          if (records.hasTurn(source.turnId))
            throw Domain.backgroundRejected(
              "limit",
              "This request already started a background group."
            )
          if (records.unfinished().length >= 2)
            throw Domain.backgroundRejected(
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
          records.put(row)
          return row
        })
      )
    }),
    authorized: Effect.fn("BackgroundMailbox.authorized")(function* (
      id: number
    ) {
      const at = yield* now
      return yield* attempt(() => {
        const row = records.get(id)
        return Domain.authorizedHandoff(
          row,
          row ? authority(row.turn_id) : "cancelled",
          at
        )
      })
    }),
    cancel: Effect.fn("BackgroundMailbox.cancel")(
      (id: number, admission?: BackgroundAdmission) =>
        Effect.try({
          try: () =>
            records.atomic(() => {
              if (admission) shared(admission)
              const row = Domain.requireHandoff(records.get(id))
              const next = Domain.cancelledHandoff(row)
              if (next !== row) records.put(next)
              admission?.stop(row.handoff.reportId)
            }),
          catch: (cause) => {
            const failure = conversationFailure(cause)
            if (failure) return failure
            const knownFailure2 = Schema.decodeUnknownOption(
              Schema.Union([DelegationFailure, BackgroundStorageError])
            )(cause)
            if (knownFailure2._tag === "Some") return knownFailure2.value
            throw cause
          },
        })
    ),
    due: Effect.fn("BackgroundMailbox.due")(function* () {
      const at = yield* now
      return yield* attempt(() =>
        records
          .unfinished()
          .filter(
            (row) =>
              Domain.polling(row) && row.next_at !== null && row.next_at <= at
          )
          .slice(0, 2)
      )
    }),
    reconcileCancellation: Effect.fn("BackgroundMailbox.reconcileCancellation")(
      function* () {
        const at = yield* now
        return yield* attempt(() =>
          records.atomic(() => {
            const cancelled = records
              .unfinished()
              .filter((row) =>
                Domain.expiredHandoff(row, authority(row.turn_id), at)
              )
            for (const row of cancelled)
              records.put(Domain.cancelledHandoff(row))
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
      yield* attempt(() =>
        records.atomic(() => {
          const row = records.get(id)
          if (row) {
            const next = Domain.observeHandoff(
              row,
              group,
              authority(row.turn_id),
              at
            )
            if (next !== row) records.put(next)
          }
        })
      )
    }),
    failed: Effect.fn("BackgroundMailbox.failed")(function* (id: number) {
      const at = yield* now
      yield* attempt(() =>
        records.atomic(() => {
          const row = records.get(id)
          if (row) {
            const next = Domain.expiredHandoff(row, authority(row.turn_id), at)
              ? Domain.cancelledHandoff(row)
              : Domain.failedHandoff(row, at)
            if (next !== row) records.put(next)
          }
        })
      )
    }),
    retry: Effect.fn("BackgroundMailbox.retry")(function* (
      id: number,
      operationId: string
    ) {
      const at = yield* now
      return yield* attempt(() =>
        records.atomic(() => {
          const prior = records.retry(operationId)
          if (prior !== undefined) {
            if (prior !== id)
              throw Domain.backgroundRejected(
                "conflict",
                "This retry belongs to another group."
              )
            return false
          }
          const row = Domain.requireHandoff(records.get(id))
          if (
            row.status !== "paused" ||
            authority(row.turn_id) === "cancelled" ||
            at >= row.handoff.deadline
          )
            throw Domain.backgroundRejected(
              "cancelled",
              "This group cannot resume."
            )
          records.putRetry(operationId, id)
          records.put({
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
      (
        admission: BackgroundAdmission
      ): Effect.Effect<boolean, BackgroundError | ConversationFailure> =>
        Effect.try({
          try: () =>
            records.atomic(() => {
              shared(admission)
              const row = records
                .unfinished()
                .find((value) => value.status === "ready")
              if (!row) return false
              const parent = authority(row.turn_id)
              if (parent === "cancelled") {
                records.put(Domain.cancelledHandoff(row))
                return false
              }
              if (parent !== "done") return false
              if (row.report === null)
                throw new Error("Ready background handoff has no report.")
              if (
                admission.admit(row.handoff, row.report) !==
                row.handoff.reportId
              )
                throw new Error(
                  "Background admission returned a different turn identity."
                )
              records.put({ ...row, status: "delivered" })
              return true
            }),
          catch: (cause) => {
            const failure = conversationFailure(cause)
            if (failure) return failure
            const knownFailure3 = Schema.decodeUnknownOption(
              Schema.Union([DelegationFailure, BackgroundStorageError])
            )(cause)
            if (knownFailure3._tag === "Some") return knownFailure3.value
            throw cause
          },
        })
    ),
    nextWake: Effect.fn("BackgroundMailbox.nextWake")(() =>
      attempt(() => {
        const times = records
          .unfinished()
          .flatMap((row) =>
            row.status === "paused"
              ? [row.handoff.deadline]
              : Domain.polling(row) && row.next_at !== null
                ? [row.next_at]
                : []
          )
        return times.length ? Math.min(...times) : undefined
      })
    ),
  }
}
