import { createEffectActor, waitFor } from "@xstate/effect"
import { Cause, Clock, Deferred, Effect, Exit, Ref } from "effect"

import {
  AccessDenied,
  type AccessConflict,
  type AccessStorageError,
  type AccessMode,
} from "./contracts"
import type { AccessLedger, ToolIntent, ToolOperation } from "./ledger"
import { scopedReceiptFact, type ReceiptQuery } from "./receipt"
import { accessRunMachine } from "./run.machine"

export class AccessGate {
  private changed = Deferred.makeUnsafe<void>()
  constructor(
    private readonly store: AccessLedger,
    private readonly canRun: (
      turnId: string,
      tool: string
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
      // The official host joins invoked work on shutdown but discards its late
      // output. Retain failure diagnostics so cancellation cannot erase a defect.
      const executionFailure = yield* Ref.make<
        Cause.Cause<AccessError | TError> | undefined
      >(undefined)
      const machine = accessRunMachine({
        begin: this.store
          .begin(intent, (id) => this.canRun(id, intent.tool))
          .pipe(Effect.tap(() => Effect.sync(() => this.notify()))),
        claim: (expiresAt, waiting) =>
          Effect.gen({ self: this }, function* () {
            // Capture before the claim so a decision between claim and wait
            // registration cannot be lost.
            const change = this.changed
            const decision = yield* this.store.claim(
              intent.id,
              recoverable,
              (id) => this.canRun(id, intent.tool)
            )
            return {
              decision,
              wake: (waiting ? Effect.void : observe("tool.waiting")).pipe(
                Effect.andThen(this.wait(change, expiresAt))
              ),
            }
          }),
        replay: (result) =>
          observe("tool.replayed").pipe(
            Effect.andThen(Effect.sync(() => JSON.parse(result) as T))
          ),
        execute: Effect.gen({ self: this }, function* () {
          yield* observe("tool.dispatched")
          // Claim and execution are distinct actor turns. Recheck the current
          // run at the consequential boundary after that mailbox gap.
          if (!(yield* this.canRun(intent.turnId, intent.tool)))
            return yield* new AccessDenied({ message: "The reply has ended." })
          const result = yield* work
          yield* this.store.finish(intent.id, JSON.stringify(result))
          yield* observe("tool.finished")
          return result
        }).pipe(
          Effect.ensuring(Effect.sync(() => this.notify())),
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? Ref.set(executionFailure, exit.cause)
              : Effect.void
          )
        ),
      })
      return yield* Effect.gen(function* () {
        const actor = yield* createEffectActor(machine)
        const settled = yield* waitFor(
          actor,
          (snapshot) => snapshot.status === "done"
        ).pipe(Effect.orDie)
        return yield* settled.context.outcome!
      }).pipe(
        Effect.scoped,
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            if (!Exit.isFailure(exit) || !Cause.hasInterrupts(exit.cause))
              return
            const failure = yield* Ref.get(executionFailure)
            const reasons =
              failure?.reasons.filter(
                (reason) =>
                  reason._tag !== "Interrupt" &&
                  !exit.cause.reasons.includes(reason)
              ) ?? []
            if (reasons.length)
              return yield* Effect.failCause(Cause.fromReasons(reasons))
          })
        )
      )
    })
  }
}

export type AccessError = AccessDenied | AccessConflict | AccessStorageError
