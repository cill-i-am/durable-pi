import { createEffectActor, send, type EffectActor } from "@xstate/effect"
import { Cause, Deferred, Effect, Exit, Scope } from "effect"

import { nativeOperation } from "../../shared/interop"
import { maintenanceRunnerHostMachine } from "../runner-host.machine"

/** The shared local owner for Memory's two maintenance runners. Durable
 * controller state stays in each runner; this scope owns activation and joins. */
export class MaintenanceRunnerHost {
  private readonly scope = Scope.makeUnsafe()
  private actor?: EffectActor<ReturnType<typeof maintenanceRunnerHostMachine>>
  private readonly operations = new Set<Promise<unknown>>()
  private closing?: Promise<void>
  constructor(private readonly restoreNative: () => Promise<void>) {}
  private getActor() {
    // Start in the first native caller's context, never in the DO constructor.
    return (this.actor ??= Effect.runSync(
      createEffectActor(
        maintenanceRunnerHostMachine(() =>
          nativeOperation(this.restoreNative, (cause) => cause)
        )
      ).pipe(Scope.provide(this.scope))
    ))
  }
  get stopped() {
    // Before the first call this is the machine's initial open admission. A
    // synchronous domain eligibility read must not start an actor inside SQL.
    return this.actor?.getSnapshot().matches({ admission: "closed" }) ?? false
  }
  track<A>(work: Promise<A>): Promise<A> {
    this.getActor()
    this.operations.add(work)
    void work.then(
      () => this.operations.delete(work),
      () => this.operations.delete(work)
    )
    return work
  }
  restore() {
    if (this.stopped) return Promise.resolve()
    const actor = this.getActor()
    const reply = Deferred.makeUnsafe<void, unknown>()
    // The installed integration's send is Effect.sync: enqueue before returning
    // this native call. Completion still waits for the actor acknowledgement.
    // Stamp the observed attempt: native completion can overtake queued joins,
    // but an older request must still receive that attempt's original result.
    const snapshot = actor.getSnapshot()
    const generation =
      snapshot.context.generation +
      (snapshot.matches({ activation: "cold" }) ? 1 : 0)
    Effect.runSync(send(actor, { type: "RESTORE", reply, generation }))
    const pending = Effect.runPromiseExit(Deferred.await(reply)).then(
      (exit) => {
        if (Exit.isFailure(exit)) throw exit.cause
      }
    )
    return this.track(pending)
  }
  dispose(join: () => Promise<void>) {
    return (this.closing ??= (async () => {
      const actor = this.getActor()
      const ack = Deferred.makeUnsafe<void>()
      Effect.runSync(send(actor, { type: "CLOSE", ack }))
      await Effect.runPromise(Deferred.await(ack))
      // Signalling the existing native owners precedes waiting for their joins.
      const cleanup = join()
      const pending = new Set([cleanup, ...this.operations])
      const outcomes = await Promise.allSettled(pending)
      const exit = await Effect.runPromiseExit(
        Scope.close(this.scope, Exit.void)
      )
      const causes = outcomes.flatMap((outcome) =>
        outcome.status === "rejected"
          ? [
              Cause.isCause(outcome.reason)
                ? outcome.reason
                : Cause.die(outcome.reason),
            ]
          : []
      )
      if (Exit.isFailure(exit)) causes.push(exit.cause)
      if (causes.length)
        throw Cause.fromReasons([
          ...new Set(causes.flatMap((cause) => cause.reasons)),
        ])
    })())
  }
}
