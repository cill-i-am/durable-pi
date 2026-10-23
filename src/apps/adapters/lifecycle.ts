import {
  LifecycleCapability,
  type LifecycleJob,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from "agents/lifecycle"
import { Effect, Exit } from "effect"

import {
  changeAppDiscovery,
  observeAppDiscovery,
  readAppDiscovery,
} from "../discovery.machine"

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
  private readonly dispatches = new Map<string, LifecycleJob>()
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
  async armDiscovery(): Promise<number> {
    let prior = this.current()
    if (!prior) {
      // SDK deletes a still-running row when its failure hook cannot persist
      // the spent marker. Settle those orphan controls before granting a fresh
      // epoch, and keep an in-flight old render fenced until its actual lease
      // expires. Such a local render cannot survive a cold host reconstruction.
      await this.host.run(this.host.exhaust(() => !this.current(), false))
      prior = this.current()
      if (!prior) {
        const now = Date.now()
        for (const [token, dispatched] of this.dispatches) {
          if (read(dispatched).armedUntil > now)
            throw new Error(
              "The previous app recovery lease is still settling. Retry after its admission deadline."
            )
          this.dispatches.delete(token)
        }
      }
    }
    const now = Date.now()
    if (prior) {
      const lease = read(prior)
      if (lease.state === "exhausted")
        throw new Error(
          "App admission recovery is exhausted. Wait for its retained lease to settle, then retry."
        )
      if (this.dispatches.has(lease.token)) {
        if (lease.armedUntil < now + 30_000)
          throw new Error(
            "App admission is busy finishing its retained recovery lease. Retry shortly."
          )
        await this.lifecycle.jobs.rearm()
        return lease.armedUntil
      }
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
  }
  async wake() {
    const current = this.current()
    // Admission prearms before commit. This post-commit doorbell must never
    // create a new execution budget after exhaustion or lost scheduling.
    if (!current) {
      await this.host.run(this.host.exhaust(() => !this.current(), false))
      return
    }
    if (this.dispatches.has(read(current).token)) {
      await this.lifecycle.jobs.rearm()
      return
    }
    await this.lifecycle.jobs.reschedule(id, Date.now())
  }
  async reconcile() {
    const current = this.current()
    await this.host.run(
      this.host.exhaust(
        () => (current ? this.owns(current) : !this.current()),
        !!current && read(current).state === "armed"
      )
    )
    await this.lifecycle.jobs.rearm()
  }
  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (!this.owns(job)) return this.outcome(job)
    // A spent marker retains its token. A stale SDK snapshot cannot regain
    // execution authority merely because its token still owns this lease.
    const lease = read(this.current()!)
    if (lease.state === "exhausted") {
      await this.host.run(this.host.exhaust(() => this.owns(job), false))
      return this.outcome(
        job,
        observeAppDiscovery(lease, Date.now(), undefined)
      )
    }
    const active = this.dispatches.get(lease.token)
    if (active && active !== job) return this.outcome(job, Date.now() + 1000)
    this.dispatches.set(lease.token, job)
    const began = Date.now()
    const next = await this.host.pump()
    this.dispatches.delete(lease.token)
    return this.outcome(job, observeAppDiscovery(lease, began, next))
  }
  async onJobError(
    { job }: LifecycleJobContext,
    error: unknown
  ): Promise<LifecycleJobOutcome> {
    if (!this.owns(job)) return this.outcome(job)
    const lease = read(job)
    if (lease.state === "armed" && this.dispatches.get(lease.token) !== job)
      return this.outcome(job)
    await this.host.run(
      Effect.logError("App delivery recovery exhausted", error)
    )
    if (lease.state === "exhausted") return this.outcome(job)
    // Persist spent dispatch authority before trying terminal writes. No new
    // pump invocation may follow this epoch, including after a cold restart.
    if (!this.owns(job)) return this.outcome(job)
    const exhausted = changeAppDiscovery(lease, { type: "EXHAUST" })
    await this.push(exhausted, lease.armedUntil)
    this.dispatches.delete(lease.token)
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
  }
}
