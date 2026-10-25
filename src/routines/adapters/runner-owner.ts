import { createEffectActor, send, type EffectActor } from "@xstate/effect"
import { Cause, Deferred, Effect, Exit, Scope } from "effect"
import type { EventFromLogic } from "xstate"

import {
  routineRunnerMachine,
  type RoutineControlAttempt,
  type RoutineRunnerDecision,
  type RoutineRunnerReply,
  type RoutineRunnerAck,
} from "../runner.machine"

type RunnerMachine = typeof routineRunnerMachine
const owners = new WeakMap<object, RoutineOwner>()

/** Warm facades share the same actor and joined native lifetime. */
export function routineOwner(identity: object) {
  let owner = owners.get(identity)
  if (!owner) {
    owner = new RoutineOwner()
    owners.set(identity, owner)
  }
  return owner
}

class RoutineOwner {
  private readonly scope = Scope.makeUnsafe()
  private actor?: EffectActor<RunnerMachine>
  private readonly operations = new Set<Promise<unknown>>()
  private closing?: Promise<void>
  private getActor() {
    return (this.actor ??= Effect.runSync(
      createEffectActor(routineRunnerMachine).pipe(Scope.provide(this.scope))
    ))
  }
  closed() {
    // Eligibility may be read inside native SQL; never start an actor there.
    return this.actor?.getSnapshot().matches({ admission: "closed" }) ?? false
  }
  track<A>(work: () => Promise<A>) {
    this.getActor()
    const pending = work()
    this.operations.add(pending)
    void pending.then(
      () => this.operations.delete(pending),
      () => this.operations.delete(pending)
    )
    return pending
  }
  ask(event: (reply: RoutineRunnerReply) => EventFromLogic<RunnerMachine>) {
    const reply = Deferred.makeUnsafe<RoutineRunnerDecision>()
    Effect.runSync(send(this.getActor(), event(reply)))
    return Effect.runPromise(Deferred.await(reply))
  }
  acknowledge(event: (ack: RoutineRunnerAck) => EventFromLogic<RunnerMachine>) {
    const ack = Deferred.makeUnsafe<void>()
    Effect.runSync(send(this.getActor(), event(ack)))
    return Effect.runPromise(Deferred.await(ack))
  }
  async schedule<A>(work: () => Promise<A>): Promise<A | undefined> {
    if (this.closed()) return
    if (
      (await this.ask((reply) => ({ type: "SCHEDULE", reply }))).permission ===
      "stopped"
    )
      return
    try {
      return this.closed() ? undefined : await work()
    } finally {
      await this.acknowledge((ack) => ({ type: "RELEASE", ack }))
    }
  }

  receipt(token: string, job: object, receipt: RoutineControlAttempt) {
    // Enqueue before completion can overtake the domain's exact claim receipt.
    Effect.runSync(
      send(this.getActor(), { type: "RECEIPT", token, job, receipt })
    )
  }
  dispose() {
    return (this.closing ??= (async () => {
      await this.acknowledge((ack) => ({ type: "CLOSE", ack }))
      const settled = await Promise.allSettled([...this.operations])
      const exit = await Effect.runPromiseExit(
        Scope.close(this.scope, Exit.void)
      )
      const causes = settled.flatMap((result) =>
        result.status === "rejected"
          ? [
              Cause.isCause(result.reason)
                ? result.reason
                : Cause.fail(result.reason),
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
