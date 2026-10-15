import { Schema, Cause, Clock, Deferred, Effect } from "effect"
import { scopedReceiptFact, type ReceiptQuery } from "./receipt"
import type { AccessLedger, ToolIntent } from "./ledger"
import {
  AccessDenied,
  AccessConflict,
  AccessStorageError,
  type AccessMode,
} from "./contracts"

export class AccessGate {
  private changed = Deferred.makeUnsafe<void>()
  constructor(
    private readonly store: AccessLedger,
    private readonly canRun: (turnId: string) => boolean,
    private readonly onChange: () => void = () => {},
    private readonly botId: () => string | null = () => null
  ) {}
  notify() {
    const previous = this.changed
    this.changed = Deferred.makeUnsafe<void>()
    Deferred.doneUnsafe(previous, Effect.void)
    this.onChange()
  }
  private wait(change: Deferred.Deferred<void>, expiresAt: number) {
    return Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      yield* Effect.raceFirst(
        Deferred.await(change),
        Effect.sleep(Math.max(1, Math.min(60_000, expiresAt - now)))
      )
    })
  }
  operation = Effect.fn("Access.operation")((id: string) =>
    accessAttempt(() => this.store.get(id))
  )
  receipt = Effect.fn("Access.receipt")((query: ReceiptQuery) =>
    accessAttempt(() => scopedReceiptFact(this.store.get(query.id), query))
  )
  state = Effect.fn("Access.state")(() =>
    accessAttempt(() => ({
      tools: this.store.policies(),
      approvals: this.store.pending(),
    }))
  )
  pending = Effect.fn("Access.pending")(() =>
    accessAttempt(() => this.store.pending())
  )
  awaitingApproval = Effect.fn("Access.awaitingApproval")((id: string) =>
    accessAttempt(() => this.store.awaitingApproval(id))
  )
  cancel = Effect.fn("Access.cancel")((id: string) =>
    accessAttempt(() => this.store.cancel(id)).pipe(
      Effect.tap(() => Effect.sync(() => this.notify()))
    )
  )
  revoke = Effect.fn("Access.revoke")((name: string) =>
    accessAttempt(() => this.store.revoke(name)).pipe(
      Effect.tap(() => Effect.sync(() => this.notify()))
    )
  )
  updatePolicy = Effect.fn("Access.updatePolicy")(
    (name: string, revision: number, mode: AccessMode) =>
      accessAttempt(() => this.store.update(name, revision, mode)).pipe(
        Effect.tap(() => Effect.sync(() => this.notify()))
      )
  )
  decide = Effect.fn("Access.decide")(
    (
      id: string,
      approve: boolean,
      revision: number,
      remember?: { expectedPolicyRevision: number }
    ) =>
      accessAttempt(() =>
        this.store.decide(id, approve, revision, remember)
      ).pipe(Effect.tap(() => Effect.sync(() => this.notify())))
  )

  run<T, TError, TRequirements>(
    intent: ToolIntent,
    work: Effect.Effect<T, TError, TRequirements>,
    recoverable = false
  ): Effect.Effect<T, AccessError | TError, TRequirements> {
    return Effect.gen({ self: this }, function* () {
      const fields = {
        botId: this.botId(),
        runId: intent.turnId,
        operationId: intent.id,
        tool: intent.tool,
      }
      const observe = (event: string) =>
        Effect.annotateCurrentSpan({
          "bot.id": fields.botId ?? "",
          "run.id": intent.turnId,
          "tool.operation_id": intent.id,
          "tool.name": intent.tool,
        }).pipe(
          Effect.andThen(
            Effect.logInfo(event).pipe(
              Effect.annotateLogs({ ...fields, event })
            )
          ),
          Effect.withSpan(event),
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            () => Effect.void
          )
        )
      let waiting = false
      const operation = yield* Effect.try({
        try: () => {
          if (!this.canRun(intent.turnId))
            throw new AccessDenied({
              message: "This reply has stopped or its bot is archived.",
            })
          return this.store.begin(intent)
        },
        catch: accessError,
      })
      this.notify()
      for (;;) {
        const change = this.changed
        const decision = yield* Effect.try({
          try: () => {
            if (!this.canRun(operation.turnId))
              throw new AccessDenied({
                message: "This reply has stopped or its bot is archived.",
              })
            return this.store.claim(intent.id, recoverable)
          },
          catch: accessError,
        })
        if (decision === "pending") {
          if (!waiting) yield* observe("tool.waiting")
          waiting = true
          yield* this.wait(change, operation.expiresAt)
          continue
        }
        if (typeof decision === "object") {
          yield* observe("tool.replayed")
          return yield* Effect.sync(() => JSON.parse(decision.result) as T)
        }
        try {
          yield* observe("tool.dispatched")
          const result = yield* work
          yield* Effect.try({
            try: () => this.store.finish(intent.id, JSON.stringify(result)),
            catch: accessError,
          })
          yield* observe("tool.finished")
          return result
        } finally {
          this.notify()
        }
      }
    })
  }
}

export type AccessError = AccessDenied | AccessConflict | AccessStorageError
const accessError = (cause: unknown): AccessError => {
  const knownFailure = Schema.decodeUnknownOption(
    Schema.Union([AccessDenied, AccessConflict, AccessStorageError])
  )(cause)
  if (knownFailure._tag === "Some") return knownFailure.value
  throw cause
}
const accessAttempt = <T>(body: () => T) =>
  Effect.try({ try: body, catch: accessError })
