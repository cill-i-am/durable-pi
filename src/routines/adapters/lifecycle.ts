import {
  LifecycleCapability,
  type LifecycleJob,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from "agents/lifecycle"
import { Effect, Schema } from "effect"

import {
  armRoutineDiscovery,
  observeRoutineDiscovery,
  readRoutineDiscovery,
} from "../discovery.machine"

export type RoutineControlAttempt = { id: string; controlRevision: number }
const Owner = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  token: Schema.String.check(Schema.isNonEmpty()),
})
const pumpId = "routines:pump"
const discoveryId = "routines:discovery"
const retry = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 }
const read = (job: LifecycleJob) => {
  if (job.id === pumpId && job.fn === "pump")
    return job.payload === undefined || job.payload === null
      ? { token: `legacy:${job.createdAt}:${job.time}` }
      : Schema.decodeUnknownSync(Owner)(job.payload)
  if (job.id === discoveryId && job.fn === "recover")
    return readRoutineDiscovery(job.payload)
  throw new Error(`Unsupported routine job: ${job.id}/${job.fn}`)
}

/** The existing Lifecycle queue owns alarm delivery. A second warm facade shares
 * the dispatch registry and cannot renew/reclaim a live owner's retry budget. */
export class RoutineRunner<E> extends LifecycleCapability {
  private readonly dispatches: Map<
    string,
    {
      job: LifecycleJob
      active: boolean
      wake: boolean
      attempt?: RoutineControlAttempt
    }
  >
  private static readonly owners = new WeakMap<
    object,
    Map<
      string,
      {
        job: LifecycleJob
        active: boolean
        wake: boolean
        attempt?: RoutineControlAttempt
      }
    >
  >()
  constructor(
    readonly host: {
      owner: object
      run: <A>(effect: Effect.Effect<A, E>) => Promise<A>
      step: (
        onAttempt: (attempt: RoutineControlAttempt) => void
      ) => Promise<number | undefined>
      nextWake: () => Effect.Effect<number | undefined, E>
      exhaust: (
        attempt: RoutineControlAttempt,
        eligible: () => boolean
      ) => Effect.Effect<boolean, E>
      notify?: () => void
    }
  ) {
    super("routines")
    this.dispatches =
      RoutineRunner.owners.get(host.owner) ??
      new Map<
        string,
        {
          job: LifecycleJob
          active: boolean
          wake: boolean
          attempt?: RoutineControlAttempt
        }
      >()
    RoutineRunner.owners.set(host.owner, this.dispatches)
  }
  private current(id: string) {
    const job = this.lifecycle.jobs.get(id)
    if (job) read(job)
    return job
  }
  private owns(job: LifecycleJob) {
    const current = this.current(job.id)
    return !!current && read(current).token === read(job).token
  }
  private outcome(job: LifecycleJob, outcome: LifecycleJobOutcome) {
    const current = this.current(job.id)
    return current && read(current).token !== read(job).token
      ? { rescheduleAt: current.time }
      : outcome
  }
  private push(time: number) {
    return this.lifecycle.jobs.push({
      id: pumpId,
      fn: "pump",
      payload: {
        schemaVersion: 1,
        workflowVersion: 1,
        token: crypto.randomUUID(),
      },
      time,
      singleflight: true,
      recoveryLoop: true,
      hungTimeoutSeconds: 600,
      retry,
    })
  }
  async armDiscovery(): Promise<number> {
    const now = Date.now(),
      deadline = now + 60_000,
      prior = this.current(discoveryId)
    await this.lifecycle.jobs.push({
      id: discoveryId,
      fn: "recover",
      payload: armRoutineDiscovery(
        prior?.payload,
        deadline,
        crypto.randomUUID()
      ),
      time: Math.min(now, prior?.time ?? Infinity),
      singleflight: true,
      recoveryLoop: true,
      retry,
    })
    return deadline
  }
  async wake() {
    const current = this.current(pumpId)
    if (!current) {
      await this.push(Date.now())
      return
    }
    const owned = this.dispatches.get(read(current).token)
    if (owned) {
      owned.wake = true
      await this.lifecycle.jobs.rearm()
      return
    }
    await this.lifecycle.jobs.reschedule(pumpId, Date.now())
  }
  async reconcile() {
    const pump = this.current(pumpId),
      discovery = this.current(discoveryId)
    if (!pump && !discovery) {
      const next = await this.host.run(this.host.nextWake())
      if (next !== undefined && !this.current(pumpId)) await this.push(next)
    }
    await this.lifecycle.jobs.rearm()
  }
  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    const owner = read(job)
    if (!this.owns(job)) return this.outcome(job, undefined)
    if (job.fn === "recover") {
      const now = Date.now()
      const pending = (await this.host.run(this.host.nextWake())) !== undefined
      let result: LifecycleJobOutcome
      for (const command of observeRoutineDiscovery(job.payload, {
        now,
        pending,
      })) {
        if (command.type === "wake") await this.wake()
        else result = { rescheduleAt: command.at }
      }
      return this.outcome(job, result)
    }
    let dispatch = this.dispatches.get(owner.token)
    if (dispatch?.active || (dispatch && dispatch.job !== job))
      return this.outcome(job, { rescheduleAt: Date.now() + 1000 })
    dispatch ??= { job, active: false, wake: false }
    dispatch.active = true
    this.dispatches.set(owner.token, dispatch)
    try {
      const next = await this.host.step((attempt) => {
        dispatch.attempt = attempt
      })
      this.dispatches.delete(owner.token)
      return this.outcome(
        job,
        dispatch.wake
          ? { rescheduleAt: Math.min(next ?? Infinity, Date.now()) }
          : next === undefined
            ? undefined
            : { rescheduleAt: next }
      )
    } finally {
      dispatch.active = false
      this.host.notify?.()
    }
  }
  async onJobError(
    { job }: LifecycleJobContext,
    error: unknown
  ): Promise<LifecycleJobOutcome> {
    const owner = read(job)
    await this.host.run(Effect.logError("Routine recovery exhausted", error))
    if (!this.owns(job)) return this.outcome(job, undefined)
    if (job.fn === "recover") {
      // Retain the final post-admission scan if an earlier scan exhausted its
      // storage retry budget. At/after the lease horizon, stop this job.
      const next = observeRoutineDiscovery(job.payload, {
        now: Date.now(),
        pending: false,
      }).find((command) => command.type === "reschedule")
      return this.outcome(job, next ? { rescheduleAt: next.at } : undefined)
    }
    const dispatch = this.dispatches.get(owner.token)
    if (!dispatch || dispatch.active || dispatch.job !== job)
      return this.outcome(job, undefined)
    try {
      if (dispatch.attempt)
        await this.host.run(
          this.host.exhaust(dispatch.attempt, () => this.owns(job))
        )
    } finally {
      this.dispatches.delete(owner.token)
      this.host.notify?.()
    }
    return this.outcome(job, undefined)
  }
}
