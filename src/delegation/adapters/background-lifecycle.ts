import { createEffectActor, send, type EffectActor } from "@xstate/effect"
import {
  LifecycleCapability,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from "agents/lifecycle"
import { Cause, Clock, Deferred, Effect, Exit, Scope } from "effect"

import {
  armBackgroundRecovery,
  observeBackgroundRecovery,
  readBackgroundRecovery,
} from "../background-recovery.machine"
import { backgroundRunnerLifetime } from "../background-runner.machine"

/** Existing background capability/job identity, persisted discovery lease and
 * domain recovery only. Lifecycle remains the single physical alarm owner. */
export class BackgroundRunner<E> extends LifecycleCapability {
  private readonly scope = Scope.makeUnsafe()
  private actor?: EffectActor<typeof backgroundRunnerLifetime>
  private readonly operations = new Set<Promise<unknown>>()
  private closing?: Promise<void>
  constructor(
    readonly host: {
      run: <A>(work: Effect.Effect<A, E>) => Promise<A>
      step: () => Promise<number | undefined>
      exhaust: (current: () => boolean) => Effect.Effect<void, E>
      nextWake: () => Effect.Effect<number | undefined, E>
    }
  ) {
    super("background-groups")
  }
  private async run<A>(work: Effect.Effect<A, E>): Promise<A> {
    const exit = await this.host.run(Effect.exit(work))
    if (Exit.isFailure(exit)) throw exit.cause
    return exit.value
  }
  private getActor() {
    return (this.actor ??= Effect.runSync(
      createEffectActor(backgroundRunnerLifetime).pipe(
        Scope.provide(this.scope)
      )
    ))
  }
  private closed() {
    // This may be read in an existing domain transaction; never start an actor there.
    return this.actor?.getSnapshot().matches("closed") ?? false
  }
  private track<A>(work: () => Promise<A>): Promise<A | undefined> {
    const actor = this.getActor()
    if (this.closed()) return Promise.resolve(undefined)
    const pending = Effect.runPromise(
      Effect.gen(function* () {
        const reply = yield* Deferred.make<boolean>()
        yield* send(actor, { type: "ADMIT", reply })
        return yield* Deferred.await(reply)
      })
    ).then((admitted) => (admitted ? work() : undefined))
    this.operations.add(pending)
    void pending.then(
      () => this.operations.delete(pending),
      () => this.operations.delete(pending)
    )
    return pending
  }
  private async schedule(time: number, deadline: number) {
    const id = "background-groups:pump"
    const prior = this.lifecycle.jobs.get(id)
    const payload = armBackgroundRecovery(
      prior?.payload,
      prior?.time ?? time,
      deadline,
      crypto.randomUUID()
    )
    await this.lifecycle.jobs.push({
      id,
      fn: "pump",
      payload,
      time: Math.min(time, prior?.time ?? Infinity),
      singleflight: true,
      recoveryLoop: true,
      hungTimeoutSeconds: 600,
      retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
    })
  }
  armBackground(deadline: number) {
    return this.track(async () => {
      if (this.closed()) return false
      await this.schedule(deadline, deadline)
      return true
    }).then((armed) => {
      if (!armed || this.closed())
        throw new Error("Background runner is stopped")
    })
  }
  wake() {
    return this.track(async () => {
      if (this.closed()) return
      const now = Date.now()
      await this.schedule(now, now)
    })
  }
  onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    return this.track(async () =>
      this.closed() ? undefined : this.dispatch(context)
    )
  }
  private async dispatch({
    job,
  }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    const now = await this.run(Clock.currentTimeMillis)
    const next = await this.host.step()
    const command = observeBackgroundRecovery(job.payload, job.time, {
      now,
      next: next ?? null,
    })[0]
    return command ? { rescheduleAt: command.at } : undefined
  }
  onJobError(
    context: LifecycleJobContext,
    error: unknown
  ): Promise<LifecycleJobOutcome> {
    return this.track(async () =>
      this.closed() ? undefined : this.failed(context, error)
    )
  }
  private async failed(
    { job }: LifecycleJobContext,
    error: unknown
  ): Promise<LifecycleJobOutcome> {
    await this.run(
      Effect.logError("Background job exhausted", { job: job.id }, error)
    )
    const now = await this.run(Clock.currentTimeMillis)
    const token = readBackgroundRecovery(job.payload, job.time).token
    const current = () => {
      if (this.closed()) return false
      const latest = this.lifecycle.jobs.get(job.id)
      return (
        !!latest &&
        readBackgroundRecovery(latest.payload, latest.time).token === token
      )
    }
    const exit = await this.run(
      Effect.exit(
        Effect.gen({ self: this }, function* () {
          yield* this.host.exhaust(current)
          return yield* this.host.nextWake()
        })
      )
    )
    if (Exit.isFailure(exit) && this.closed()) throw exit.cause
    if (Exit.isFailure(exit))
      await this.run(
        Effect.logError(
          "Background terminal persistence is unconfirmed",
          exit.cause
        )
      )
    // Do not renew an exhausted lease after a storage outage. Domain rows remain
    // intact for explicit Stop/retry or activation reconciliation; an already
    // armed newer admission is retained and a concurrent job replacement wins.
    const next = Exit.isSuccess(exit) ? (exit.value ?? null) : null
    const command = observeBackgroundRecovery(job.payload, job.time, {
      now,
      next,
    })[0]
    return command ? { rescheduleAt: command.at } : undefined
  }
  dispose() {
    return (this.closing ??= (async () => {
      const ack = Deferred.makeUnsafe<void>()
      Effect.runSync(send(this.getActor(), { type: "CLOSE", ack }))
      await Effect.runPromise(Deferred.await(ack))
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
