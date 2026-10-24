import { createEffectActor, send, type EffectActor } from "@xstate/effect"
import {
  LifecycleCapability,
  type LifecycleJob,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from "agents/lifecycle"
import { Cause, Deferred, Effect, Exit, Scope } from "effect"
import type { EventFromLogic } from "xstate"

import {
  changeAppDiscovery,
  observeAppDiscovery,
  readAppDiscovery,
} from "../discovery.machine"
import {
  appRunnerMachine,
  type AppRunnerReply,
  type AppRunnerAck,
  type AppRunnerPermission,
} from "../runner.machine"

const id = "app-events:pump"
const retry = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 }
const read = (job: LifecycleJob) => {
  if (job.id !== id || job.fn !== "pump")
    throw new Error("Unsupported app delivery job")
  return readAppDiscovery(
    job.payload ?? {
      schemaVersion: 1,
      workflowVersion: 1,
      state: "armed",
      token: `legacy:${job.createdAt}:${job.time}`,
      armedUntil: Math.max(job.createdAt, job.time) + 60_000,
    }
  )
}
/** One retained job owns both discovery and bounded dispatch. An active lease
 * cannot be extended by a doorbell: new admission uses its persisted deadline
 * or fails before commit. An exhausted lease only terminalizes late commits. */
export class AppEventRunner<E> extends LifecycleCapability {
  private readonly scope = Scope.makeUnsafe()
  private actor?: EffectActor<typeof appRunnerMachine>
  private readonly operations = new Set<Promise<unknown>>()
  private closing?: Promise<void>
  constructor(
    readonly host: {
      run: <A>(work: Effect.Effect<A, E>) => Promise<A>
      pump: () => Promise<number | undefined>
      next: () => Effect.Effect<number | undefined, E>
      exhaust: (
        eligible: () => boolean,
        expiredOnly: boolean
      ) => Effect.Effect<void, E>
    }
  ) {
    super("app-events")
  }
  private getActor() {
    return (this.actor ??= Effect.runSync(
      createEffectActor(appRunnerMachine).pipe(Scope.provide(this.scope))
    ))
  }
  private closed() {
    return this.getActor().getSnapshot().matches("closed")
  }
  private track<A>(work: () => Promise<A>): Promise<A> {
    const pending = work()
    this.operations.add(pending)
    void pending.then(
      () => this.operations.delete(pending),
      () => this.operations.delete(pending)
    )
    return pending
  }
  private ask(
    event: (reply: AppRunnerReply) => EventFromLogic<typeof appRunnerMachine>
  ) {
    if (this.closed()) return Promise.resolve("stopped" as const)
    const actor = this.getActor()
    return Effect.runPromise(
      Effect.gen(function* () {
        const reply = yield* Deferred.make<AppRunnerPermission>()
        yield* send(actor, event(reply))
        return yield* Deferred.await(reply)
      })
    )
  }
  private acknowledge(
    event: (ack: AppRunnerAck) => EventFromLogic<typeof appRunnerMachine>
  ) {
    const actor = this.getActor()
    return Effect.runPromise(
      Effect.gen(function* () {
        const ack = yield* Deferred.make<void>()
        yield* send(actor, event(ack))
        yield* Deferred.await(ack)
      })
    )
  }
  private async schedule<A>(work: () => Promise<A>): Promise<A | undefined> {
    if (
      (await this.ask((reply) => ({ type: "SCHEDULE", reply }))) === "stopped"
    )
      return
    try {
      return this.closed() ? undefined : await work()
    } finally {
      await this.acknowledge((ack) => ({ type: "RELEASE", ack }))
    }
  }
  private current() {
    const job = this.lifecycle.jobs.get(id)
    if (job) read(job)
    return job
  }
  private owns(job: LifecycleJob) {
    const current = this.current()
    return !!current && read(current).token === read(job).token
  }
  private outcome(job: LifecycleJob, at?: number): LifecycleJobOutcome {
    const current = this.current()
    if (
      current &&
      (read(current).token !== read(job).token ||
        read(current).state !== read(job).state)
    )
      return { rescheduleAt: current.time }
    return at === undefined ? undefined : { rescheduleAt: at }
  }
  private push(payload: ReturnType<typeof read>, time: number) {
    return this.lifecycle.jobs.push({
      id,
      fn: "pump",
      payload,
      time,
      singleflight: true,
      recoveryLoop: true,
      hungTimeoutSeconds: 600,
      retry,
    })
  }
  armDiscovery(): Promise<number> {
    return this.track(() =>
      this.schedule(async () => {
        let prior = this.current()
        if (!prior) {
          // Settle orphan rows before granting a fresh lease. The machine also
          // retains any old in-flight callback until its original lease expires.
          await this.host.run(this.host.exhaust(() => !this.current(), false))
          prior = this.current()
        }
        const now = Date.now()
        const permission = await this.ask((reply) => ({
          type: "ARM",
          lease: prior ? read(prior) : null,
          now,
          reply,
        }))
        if (permission === "orphan")
          throw new Error(
            "The previous app recovery lease is still settling. Retry after its admission deadline."
          )
        if (permission === "spent")
          throw new Error(
            "App admission recovery is exhausted. Wait for its retained lease to settle, then retry."
          )
        if (permission === "busy")
          throw new Error(
            "App admission is busy finishing its retained recovery lease. Retry shortly."
          )
        if (this.closed()) return
        if (permission === "reuse") {
          await this.lifecycle.jobs.rearm()
          return read(prior!).armedUntil
        }
        const deadline = now + 60_000
        const payload = changeAppDiscovery(
          prior
            ? read(prior)
            : {
                schemaVersion: 1,
                workflowVersion: 1,
                state: "armed",
                token: crypto.randomUUID(),
                armedUntil: deadline,
              },
          { type: "ARM", token: crypto.randomUUID(), deadline }
        )
        await this.push(payload, Math.min(now, prior?.time ?? Infinity))
        return payload.armedUntil
      })
    ).then((deadline) => {
      // Refusing a late lease is the caller's admission result, not a native
      // cleanup failure retained by the owning operation set.
      if (deadline === undefined || this.closed())
        throw new Error("App runner has been disposed")
      return deadline
    })
  }
  wake() {
    return this.track(() =>
      this.schedule(async () => {
        const current = this.current()
        const permission = await this.ask((reply) => ({
          type: "WAKE",
          token: current ? read(current).token : null,
          reply,
        }))
        if (this.closed()) return
        if (permission === "empty") {
          await this.host.run(this.host.exhaust(() => !this.current(), false))
        } else if (permission === "rearm") await this.lifecycle.jobs.rearm()
        else if (permission === "reschedule")
          await this.lifecycle.jobs.reschedule(id, Date.now())
      })
    )
  }
  reconcile() {
    return this.track(() =>
      this.schedule(async () => {
        const current = this.current()
        await this.host.run(
          this.host.exhaust(
            () => (current ? this.owns(current) : !this.current()),
            !!current && read(current).state === "armed"
          )
        )
        if (!this.closed()) await this.lifecycle.jobs.rearm()
      })
    )
  }
  onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    return this.track(async () => {
      if (this.closed()) return
      const current = this.current()
      const lease = read(current ?? job)
      const permission = await this.ask((reply) => ({
        type: "ADMIT",
        token: lease.token,
        job,
        until: lease.armedUntil,
        current: this.owns(job),
        spent: lease.state === "exhausted",
        reply,
      }))
      if (permission === "stopped") return
      if (permission === "stale") return this.outcome(job)
      if (permission === "defer") return this.outcome(job, Date.now() + 1000)
      if (permission === "exhaust") {
        if (!this.closed() && this.owns(job))
          await this.host.run(this.host.exhaust(() => this.owns(job), false))
        return this.outcome(
          job,
          observeAppDiscovery(lease, Date.now(), undefined)
        )
      }
      const token = lease.token
      try {
        if (this.closed() || !this.owns(job)) {
          await this.acknowledge((ack) => ({
            type: "FINISHED",
            token,
            job,
            ack,
          }))
          return this.closed() ? undefined : this.outcome(job)
        }
        const began = Date.now()
        const next = await this.host.pump()
        await this.acknowledge((ack) => ({ type: "FINISHED", token, job, ack }))
        return this.closed()
          ? undefined
          : this.outcome(job, observeAppDiscovery(lease, began, next))
      } catch (error) {
        await this.acknowledge((ack) => ({ type: "FAILED", token, job, ack }))
        throw error
      }
    })
  }
  onJobError(
    { job }: LifecycleJobContext,
    error: unknown
  ): Promise<LifecycleJobOutcome> {
    return this.track(() =>
      this.schedule(async () => {
        if (!this.owns(job)) return this.outcome(job)
        const lease = read(job)
        if (lease.state === "exhausted") return this.outcome(job)
        const permission = await this.ask((reply) => ({
          type: "ERROR",
          token: lease.token,
          job,
          current: this.owns(job),
          reply,
        }))
        if (permission === "stopped") return
        if (permission !== "start") return this.outcome(job)
        try {
          await this.host.run(
            Effect.logError("App delivery recovery exhausted", error)
          )
          if (this.closed() || !this.owns(job)) return this.outcome(job)
          // Commit spent authority before terminal writes; this never grants a
          // new pump attempt, including after a cold restart or lost response.
          const exhausted = changeAppDiscovery(lease, { type: "EXHAUST" })
          await this.push(exhausted, lease.armedUntil)
          await this.acknowledge((ack) => ({
            type: "SPENT",
            token: lease.token,
            job,
            ack,
          }))
          if (this.closed()) return
          const settled = await this.host.run(
            Effect.exit(this.host.exhaust(() => this.owns(job), false))
          )
          if (Exit.isFailure(settled))
            await this.host.run(
              Effect.logError(
                "App terminal persistence is unconfirmed; retained lease and event deadline remain",
                settled.cause
              )
            )
          return this.outcome(
            job,
            observeAppDiscovery(exhausted, Date.now(), undefined)
          )
        } catch (cause) {
          await this.acknowledge((ack) => ({
            type: "FAILED",
            token: lease.token,
            job,
            ack,
          }))
          throw cause
        }
      })
    )
  }
  dispose() {
    return (this.closing ??= (async () => {
      await this.acknowledge((ack) => ({ type: "CLOSE", ack }))
      const settled = await Promise.allSettled([...this.operations])
      const closed = await Effect.runPromiseExit(
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
      if (Exit.isFailure(closed)) causes.push(closed.cause)
      if (causes.length)
        throw Cause.fromReasons(causes.flatMap((cause) => cause.reasons))
    })())
  }
}
