import { Cause, Clock, Deferred, Effect } from "effect"

import type {
  AccessDenied,
  AccessConflict,
  AccessStorageError,
  AccessMode,
} from "./contracts"
import type { AccessLedger, ToolIntent, ToolOperation } from "./ledger"
import { scopedReceiptFact, type ReceiptQuery } from "./receipt"

export class AccessGate {
  private changed = Deferred.makeUnsafe<void>()
  constructor(
    private readonly store: AccessLedger,
    private readonly canRun: (
      turnId: string
    ) => Effect.Effect<boolean, AccessError>,
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
  operation = Effect.fn("Access.operation")((id: string) => this.store.get(id))
  receipt = Effect.fn("Access.receipt")((query: ReceiptQuery) =>
    this.store
      .get(query.id)
      .pipe(Effect.map((operation) => scopedReceiptFact(operation, query)))
  )
  state = Effect.fn("Access.state")(() =>
    Effect.gen({ self: this }, function* () {
      return {
        tools: yield* this.store.policies(),
        approvals: yield* this.store.pending(),
      }
    })
  )
  pending = Effect.fn("Access.pending")(() => this.store.pending())
  awaitingApproval = Effect.fn("Access.awaitingApproval")((id: string) =>
    this.store.awaitingApproval(id)
  )
  cancel = Effect.fn("Access.cancel")((id: string) =>
    this.store
      .cancel(id)
      .pipe(Effect.tap(() => Effect.sync(() => this.notify())))
  )
  revoke = Effect.fn("Access.revoke")((name: string) =>
    this.store
      .revoke(name)
      .pipe(Effect.tap(() => Effect.sync(() => this.notify())))
  )
  updatePolicy = Effect.fn("Access.updatePolicy")(
    (name: string, revision: number, mode: AccessMode) =>
      this.store
        .update(name, revision, mode)
        .pipe(Effect.tap(() => Effect.sync(() => this.notify())))
  )
  decide = <CommitError = never>(
    id: string,
    approve: boolean,
    revision: number,
    remember?: { expectedPolicyRevision: number },
    commit?: (
      decision: Effect.Effect<ToolOperation, AccessError>
    ) => Effect.Effect<ToolOperation, AccessError | CommitError>
  ) => {
    const decision = this.store.decide(id, approve, revision, remember)
    // Wake tool execution only after the outer authority transaction has
    // committed. A resumed native tool must never inherit its storage lease.
    return (commit ? commit(decision) : decision).pipe(
      Effect.tap(() => Effect.sync(() => this.notify())),
      Effect.withSpan("Access.decide")
    )
  }

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
      const operation = yield* this.store.begin(intent, this.canRun)
      this.notify()
      for (;;) {
        const change = this.changed
        const decision = yield* this.store.claim(
          intent.id,
          recoverable,
          this.canRun
        )
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
          yield* this.store.finish(intent.id, JSON.stringify(result))
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
