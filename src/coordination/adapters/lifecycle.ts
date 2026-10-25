import { createEffectActor, send, type EffectActor } from "@xstate/effect"
import {
  LifecycleCapability,
  type LifecycleJob,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from "agents/lifecycle"
import { Cause, Clock, Deferred, Effect, Exit, Schema, Scope } from "effect"
import type { EventFromLogic } from "xstate"

import { nativeFailure, nativeOperation } from "../../shared/interop"
import { CoordinationFailure, fail } from "../contracts"
import {
  armCoordinationDiscovery,
  observeCoordinationDiscovery,
  readCoordinationDiscovery,
} from "../discovery.machine"
import {
  coordinationRunnerMachine,
  type RunnerReply,
  type RunnerAck,
  type RunnerPermission,
} from "../runner.machine"

/** Lifecycle retains durable scheduling and its three-attempt budget. The local
 * actor owns activation, exact callback admission, and wake coalescing. */
export class CoordinationRunner<E> extends LifecycleCapability {
  private readonly scope = Scope.makeUnsafe()
  private actor?: EffectActor<ReturnType<typeof coordinationRunnerMachine>>
  private readonly operations = new Set<Promise<unknown>>()
  private closing?: Promise<void>
  constructor(
    readonly host: {
      run: <A>(work: Effect.Effect<A, E>) => Promise<A>
      step: () => Promise<number | undefined>
      restore: () => Effect.Effect<void, E>
      exhaust: (current: () => boolean) => Effect.Effect<void, E>
      nextWake: () => Effect.Effect<number | undefined, E>
      notify?: () => void
    }
  ) {
    super("agent-coordination")
  }
  private async run<A>(work: Effect.Effect<A, E>): Promise<A> {
    const exit = await this.host.run(Effect.exit(work))
    if (Exit.isFailure(exit)) throw exit.cause
    return exit.value
  }
  private getActor() {
    // Lifecycle's reentrant startup context is established by the first caller,
    // after construction. Restoration must retain it when it reads native Pi.
    return (this.actor ??= Effect.runSync(
      createEffectActor(
        coordinationRunnerMachine({
          restore: () => Effect.suspend(() => this.host.restore()),
        })
      ).pipe(Scope.provide(this.scope))
    ))
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
  private async stopped() {
    return this.getActor().getSnapshot().matches({ admission: "closed" })
  }
  private async request(
    event: (
      reply: RunnerReply
    ) => EventFromLogic<ReturnType<typeof coordinationRunnerMachine>>
  ) {
    const actor = this.getActor()
    if (actor.getSnapshot().matches({ admission: "closed" }))
      return "stopped" as const
    return Effect.runPromise(
      Effect.gen(function* () {
        const reply = yield* Deferred.make<RunnerPermission>()
        yield* send(actor, event(reply))
        return yield* Deferred.await(reply)
      })
    )
  }
  private async observe(
    event: (
      ack: RunnerAck
    ) => EventFromLogic<ReturnType<typeof coordinationRunnerMachine>>
  ) {
    const actor = this.getActor()
    await Effect.runPromise(
      Effect.gen(function* () {
        const ack = yield* Deferred.make<void>()
        yield* send(actor, event(ack))
        yield* Deferred.await(ack)
      })
    )
  }
  private async native<A>(start: () => Promise<A>) {
    const exit = await Effect.runPromiseExit(
      nativeOperation(start, (cause) => cause).pipe(Effect.scoped)
    )
    if (Exit.isFailure(exit)) throw exit.cause
    return exit.value
  }
  private current() {
    return this.lifecycle.jobs.get("agent-coordination:pump")
  }
  private token(job: LifecycleJob) {
    return readCoordinationDiscovery(job.payload, job.time).token
  }
  private outcome(job: LifecycleJob, outcome: LifecycleJobOutcome) {
    const latest = this.current()
    return latest && this.token(latest) !== this.token(job)
      ? { rescheduleAt: latest.time }
      : outcome
  }
  private async schedule(time: number, deadline: number) {
    const prior = this.current()
    const payload = armCoordinationDiscovery(
      prior?.payload,
      prior?.time ?? time,
      deadline,
      crypto.randomUUID()
    )
    await this.lifecycle.jobs.push({
      id: "agent-coordination:pump",
      fn: "pump",
      payload,
      time: Math.min(time, prior?.time ?? Infinity),
      singleflight: true,
      hungTimeoutSeconds: 600,
      recoveryLoop: true,
      retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
    })
  }
  armDiscovery() {
    return this.track(async () => {
      if (
        (await this.request((reply) => ({ type: "ARM", reply }))) === "stopped"
      )
        return
      const now = Date.now(),
        deadline = now + 60_000
      await this.schedule(now, deadline)
      return deadline
    }).then(async (deadline) => {
      if (deadline === undefined || (await this.stopped()))
        throw new Error("Coordination runner has been disposed")
      return deadline
    })
  }
  wake() {
    return this.track(async () => {
      const permission = await this.request((reply) => ({
        type: "WAKE",
        reply,
      }))
      if (permission === "stopped") return
      if (permission === "rearm") {
        await this.lifecycle.jobs.rearm()
        return
      }
      const now = Date.now()
      await this.schedule(now, now)
    })
  }
  private async restore() {
    const actor = this.getActor()
    if (actor.getSnapshot().matches({ admission: "closed" })) return
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const reply = yield* Deferred.make<void, unknown>()
        yield* send(actor, { type: "RESTORE", reply })
        yield* Deferred.await(reply)
      })
    )
    if (Exit.isFailure(exit)) throw exit.cause
  }
  reconcile() {
    return this.track(async () => {
      await this.restore()
      if (await this.stopped()) return
      if (!this.current()) {
        const next = await this.run(this.host.nextWake())
        if (await this.stopped()) return
        if (next !== undefined && !this.current())
          await this.schedule(next, next)
      }
      await this.lifecycle.jobs.rearm()
    })
  }
  onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    return this.track(async () => {
      await this.restore()
      if (await this.stopped()) return
      const latest = this.current()
      const permission = await this.request((reply) => ({
        type: "ADMIT",
        job,
        current: !!latest && this.token(latest) === this.token(job),
        reply,
      }))
      if (permission === "stopped") return
      if (permission !== "start")
        return this.outcome(
          job,
          permission === "defer"
            ? { rescheduleAt: Date.now() + 1000 }
            : undefined
        )
      try {
        const { now, next } = await this.native(async () => ({
          now: await this.run(Clock.currentTimeMillis),
          next: await this.host.step(),
        }))
        const wake = await this.request((reply) => ({
          type: "STEP_FINISHED",
          job,
          reply,
        }))
        if (await this.stopped()) return
        const command = observeCoordinationDiscovery(job.payload, job.time, {
          now,
          next:
            wake === "rearm" ? Math.min(next ?? Infinity, now) : (next ?? null),
        })[0]
        return this.outcome(
          job,
          command ? { rescheduleAt: command.at } : undefined
        )
      } catch (error) {
        await this.observe((ack) => ({ type: "STEP_FAILED", job, ack }))
        throw error
      } finally {
        this.host.notify?.()
      }
    })
  }
  onJobError(
    { job }: LifecycleJobContext,
    error: unknown
  ): Promise<LifecycleJobOutcome> {
    return this.track(async () => {
      const permission = await this.request((reply) => ({
        type: "EXHAUST",
        job,
        reply,
      }))
      if (permission === "stopped") return
      if (permission !== "start")
        return this.outcome(job, { rescheduleAt: Date.now() + 1000 })
      try {
        return await this.native(async () => {
          const current = () => {
            if (this.actor?.getSnapshot().matches({ admission: "closed" }))
              return false
            const latest = this.current()
            return !!latest && this.token(latest) === this.token(job)
          }
          const exit = await this.run(Effect.exit(this.host.exhaust(current)))
          if (Exit.isFailure(exit) && (await this.stopped())) throw exit.cause
          if (Exit.isFailure(exit))
            await this.run(
              Effect.logError(
                "Coordination recovery persistence is unconfirmed",
                exit.cause
              )
            )
          await this.run(
            Effect.logError("Coordination recovery exhausted", error)
          )
          if (await this.stopped()) return
          const now = await this.run(Clock.currentTimeMillis)
          const command = observeCoordinationDiscovery(job.payload, job.time, {
            now,
            next: null,
          })[0]
          return this.outcome(
            job,
            command ? { rescheduleAt: command.at } : undefined
          )
        })
      } finally {
        await this.observe((ack) => ({ type: "EXHAUSTED", job, ack }))
      }
    })
  }
  dispose() {
    return (this.closing ??= (async () => {
      await this.observe((ack) => ({ type: "CLOSE", ack }))
      const settled = await Promise.allSettled([...this.operations])
      const exit = await Effect.runPromiseExit(
        Scope.close(this.scope, Exit.void)
      )
      const failures = settled.flatMap((result) =>
        result.status === "rejected"
          ? [
              Cause.isCause(result.reason)
                ? result.reason
                : Cause.die(result.reason),
            ]
          : []
      )
      if (Exit.isFailure(exit)) failures.push(exit.cause)
      if (failures.length)
        throw Cause.fromReasons(failures.flatMap((cause) => cause.reasons))
    })())
  }
}

/** Scheduling retains only a durable wake value. An unacknowledged prearm
 * grants no admission; a late scheduler completion cannot dispatch work. */
export const observeCoordinationSchedule = <A>(
  operation: string,
  start: () => Promise<A>
) =>
  Effect.suspend(() => {
    const pending = start()
    return Effect.tryPromise({
      try: () => pending,
      catch: (cause) =>
        nativeFailure(cause, (failure, channel) => {
          const declared =
            Schema.decodeUnknownOption(CoordinationFailure)(failure)
          if (declared._tag === "Some") return declared.value
          if (channel === "failure" || Schema.isSchemaError(failure))
            throw failure
          return fail(
            "unavailable",
            `${operation}: coordination scheduling could not be confirmed.`
          )
        }),
    }).pipe(Effect.catch((cause) => Effect.failCause(cause)))
  }).pipe(
    Effect.timeoutOrElse({
      duration: 5000,
      orElse: () =>
        Effect.fail(
          fail(
            "unavailable",
            `${operation}: coordination scheduling did not respond within five seconds.`
          )
        ),
    }),
    Effect.interruptible
  )
