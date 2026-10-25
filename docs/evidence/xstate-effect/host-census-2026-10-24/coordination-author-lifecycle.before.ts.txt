import {
  LifecycleCapability,
  type LifecycleJob,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from "agents/lifecycle"
import { Clock, Effect, Exit, Schema } from "effect"

import { nativeFailure } from "../../shared/interop"
import { CoordinationFailure, fail } from "../contracts"
import {
  armCoordinationDiscovery,
  observeCoordinationDiscovery,
  readCoordinationDiscovery,
} from "../discovery.machine"

/** The existing capability/job remain the wake owner. Admission prearms a
 * retained lease; empty scans and stale callbacks cannot erase newer work. */
export class CoordinationRunner<E> extends LifecycleCapability {
  private restoring?: Promise<void>
  private restored = false
  private active?: { job: LifecycleJob; wakeRequested: boolean }
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
  async armDiscovery() {
    const now = Date.now(),
      deadline = now + 60_000
    await this.schedule(now, deadline)
    return deadline
  }
  async wake() {
    if (this.active) {
      this.active.wakeRequested = true
      await this.lifecycle.jobs.rearm()
      return
    }
    const now = Date.now()
    await this.schedule(now, now)
  }
  private async restore() {
    if (this.restored) return
    this.restoring ??= this.host.run(this.host.restore()).then(
      () => {
        this.restored = true
      },
      (error: unknown) => {
        this.restoring = undefined
        throw error
      }
    )
    await this.restoring
  }
  async reconcile() {
    await this.restore()
    if (!this.current()) {
      const next = await this.host.run(this.host.nextWake())
      if (next !== undefined && !this.current()) await this.schedule(next, next)
    }
    await this.lifecycle.jobs.rearm()
  }
  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    await this.restore()
    const latest = this.current()
    if (!latest || this.token(latest) !== this.token(job))
      return this.outcome(job, undefined)
    if (this.active && this.active.job !== job)
      return this.outcome(job, { rescheduleAt: Date.now() + 1000 })
    const dispatch = this.active ?? { job, wakeRequested: false }
    this.active = dispatch
    try {
      const now = await this.host.run(Clock.currentTimeMillis)
      const next = await this.host.step()
      this.active = undefined
      const command = observeCoordinationDiscovery(job.payload, job.time, {
        now,
        next: dispatch.wakeRequested
          ? Math.min(next ?? Infinity, now)
          : (next ?? null),
      })[0]
      return this.outcome(
        job,
        command ? { rescheduleAt: command.at } : undefined
      )
    } finally {
      this.host.notify?.()
    }
  }
  async onJobError(
    { job }: LifecycleJobContext,
    error: unknown
  ): Promise<LifecycleJobOutcome> {
    // A hung SDK replacement cannot exhaust the original still-running owner,
    // even when both callbacks carry the same durable scheduling token.
    if (this.active && this.active.job !== job)
      return this.outcome(job, { rescheduleAt: Date.now() + 1000 })
    // No active dispatch means cold restoration failed before step began.
    // Attempt to record that current job's exhausted recovery too, retaining
    // the prearmed lease even if restoration/persistence remains unavailable.
    if (this.active?.job === job) this.active = undefined
    const current = () => {
      const latest = this.current()
      return !!latest && this.token(latest) === this.token(job)
    }
    const exit = await this.host.run(Effect.exit(this.host.exhaust(current)))
    if (Exit.isFailure(exit))
      await this.host.run(
        Effect.logError(
          "Coordination recovery persistence is unconfirmed",
          exit.cause
        )
      )
    await this.host.run(
      Effect.logError("Coordination recovery exhausted", error)
    )
    const now = await this.host.run(Clock.currentTimeMillis)
    const command = observeCoordinationDiscovery(job.payload, job.time, {
      now,
      next: null,
    })[0]
    return this.outcome(job, command ? { rescheduleAt: command.at } : undefined)
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
