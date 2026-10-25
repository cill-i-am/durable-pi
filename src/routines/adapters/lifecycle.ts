import {
  LifecycleCapability,
  type LifecycleJob,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from "agents/lifecycle"
import { Effect, Exit, Schema } from "effect"

import {
  armRoutineDiscovery,
  observeRoutineDiscovery,
  readRoutineDiscovery,
} from "../discovery.machine"

const PumpOwner = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  token: Schema.String.check(Schema.isNonEmpty()),
})
export type { RoutineControlAttempt } from "../runner.machine"
import type { RoutineControlAttempt } from "../runner.machine"
import { routineOwner } from "./runner-owner"
const pumpId = "routines:pump"
const discoveryId = "routines:discovery"
const discoveryDuration = 60_000
const retry = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 }

function readJob(job: LifecycleJob) {
  if (job.id === pumpId && job.fn === "pump") {
    // The prior TurnRunner persisted no payload. Preserve its identity until
    // its ordinary job completes; a future format requires an explicit migration.
    return job.payload === undefined || job.payload === null
      ? { token: `legacy:${job.createdAt}:${job.time}` }
      : Schema.decodeUnknownSync(PumpOwner)(job.payload)
  }
  if (job.id === discoveryId && job.fn === "recover")
    return readRoutineDiscovery(job.payload)
  throw new Error(`Unsupported routine job: ${job.id}/${job.fn}`)
}

/** Queue orchestration uses the shared warm owner for admission and joined close. */
export class RoutineRunner<E> extends LifecycleCapability {
  private readonly owner: ReturnType<typeof routineOwner>
  constructor(
    readonly host: {
      owner: object
      run: <A>(work: Effect.Effect<A, E>) => Promise<A>
      step: (
        onAttempt: (attempt: RoutineControlAttempt) => void
      ) => Promise<number | undefined>
      /** Re-read eligibility inside the same synchronous domain transaction as
       * the exact run/control-revision exhaustion event. Never exhaust an owned row. */
      exhaust: (
        attempt: RoutineControlAttempt,
        eligible: () => boolean
      ) => Effect.Effect<boolean, E>
      nextWake: () => Effect.Effect<number | undefined, E>
      notify?: () => void
    }
  ) {
    super("routines")
    this.owner = routineOwner(host.owner)
  }

  private async run<A>(work: Effect.Effect<A, E>): Promise<A> {
    // The native runner squashes failed Exits. Keep the whole Exit as its
    // successful value until this boundary can return every original reason.
    const exit = await this.host.run(Effect.exit(work))
    if (Exit.isFailure(exit)) throw exit.cause
    return exit.value
  }
  private current(id: string) {
    const job = this.lifecycle.jobs.get(id)
    if (job) readJob(job)
    return job
  }
  private owns(job: LifecycleJob) {
    if (this.owner.closed()) return false
    const latest = this.current(job.id)
    return !!latest && readJob(latest).token === readJob(job).token
  }
  private outcome(job: LifecycleJob, outcome: LifecycleJobOutcome) {
    if (this.owner.closed()) return
    const latest = this.current(job.id)
    // The SDK guards outcomes with a running bit. A second alarm may already
    // have marked a newer same-ID job running, so an old completion must retain
    // that newer intent instead of deleting it or applying its old deadline.
    return latest && readJob(latest).token !== readJob(job).token
      ? { rescheduleAt: latest.time }
      : outcome
  }
  private async pushPump(time: number) {
    await this.lifecycle.jobs.push({
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
  armDiscovery(): Promise<number> {
    return this.owner
      .track(() =>
        this.owner.schedule(async () => {
          const now = Date.now(),
            deadline = now + discoveryDuration
          const prior = this.current(discoveryId)
          const payload = armRoutineDiscovery(
            prior?.payload,
            deadline,
            crypto.randomUUID()
          )
          await this.lifecycle.jobs.push({
            id: discoveryId,
            fn: "recover",
            payload,
            time: Math.min(now, prior?.time ?? Infinity),
            singleflight: true,
            recoveryLoop: true,
            retry,
          })
          return deadline
        })
      )
      .then((deadline) => {
        if (deadline === undefined || this.owner.closed())
          throw new Error("Routine runner is stopped")
        return deadline
      })
  }
  wake() {
    return this.owner.track(() =>
      this.owner.schedule(async () => {
        const current = this.current(pumpId)
        const { permission } = await this.owner.ask((reply) => ({
          type: "WAKE",
          token: current ? readJob(current).token : null,
          reply,
        }))
        if (this.owner.closed()) return
        if (permission === "empty") await this.pushPump(Date.now())
        else if (permission === "rearm") await this.lifecycle.jobs.rearm()
        else if (permission === "schedule")
          await this.lifecycle.jobs.reschedule(pumpId, Date.now())
      })
    )
  }
  reconcile() {
    return this.owner.track(async () => {
      if (this.owner.closed()) return
      this.current(pumpId)
      this.current(discoveryId)
      await this.owner.schedule(async () => {
        if (!this.current(pumpId) && !this.current(discoveryId)) {
          const next = await this.run(this.host.nextWake())
          if (
            !this.owner.closed() &&
            next !== undefined &&
            !this.current(pumpId)
          )
            await this.pushPump(next)
        }
        if (!this.owner.closed()) await this.lifecycle.jobs.rearm()
      })
    })
  }
  onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    return this.owner.track(() => this.dispatch(context))
  }
  private async dispatch({
    job,
  }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (this.owner.closed()) return
    const { token } = readJob(job)
    if (!this.owns(job)) return this.outcome(job, undefined)
    if (job.fn === "recover") {
      // Capture scan start before storage: admission may commit while it waits.
      const now = Date.now()
      const pending = (await this.run(this.host.nextWake())) !== undefined
      let outcome: LifecycleJobOutcome
      for (const command of observeRoutineDiscovery(job.payload, {
        now,
        pending,
      })) {
        if (command.type === "wake") await this.wake()
        else outcome = { rescheduleAt: command.at }
      }
      return this.outcome(job, outcome)
    }
    const { permission } = await this.owner.ask((reply) => ({
      type: "ADMIT",
      token,
      job,
      current: this.owns(job),
      reply,
    }))
    if (permission === "stopped") return
    if (permission !== "start")
      return this.outcome(
        job,
        permission === "defer" ? { rescheduleAt: Date.now() + 1000 } : undefined
      )
    // An intervening close/replacement cannot spend the granted callback.
    if (this.owner.closed() || !this.owns(job)) {
      await this.owner.ask((reply) => ({ type: "FINISHED", token, job, reply }))
      return this.outcome(job, undefined)
    }
    try {
      const next = await this.host.step((receipt) => {
        // Receipt observation occurs after the domain claim transaction. Enqueue
        // synchronously so completion cannot overtake this exact receipt.
        this.owner.receipt(token, job, receipt)
      })
      const result = await this.owner.ask((reply) => ({
        type: "FINISHED",
        token,
        job,
        reply,
      }))
      return this.outcome(
        job,
        result.permission === "rearm"
          ? { rescheduleAt: Math.min(next ?? Infinity, Date.now()) }
          : next === undefined
            ? undefined
            : { rescheduleAt: next }
      )
    } catch (error) {
      await this.owner.acknowledge((ack) => ({
        type: "FAILED",
        token,
        job,
        ack,
      }))
      throw error
    } finally {
      this.host.notify?.()
    }
  }
  onJobError(
    context: LifecycleJobContext,
    error: unknown
  ): Promise<LifecycleJobOutcome> {
    return this.owner.track(() => this.failed(context, error))
  }
  private async failed(
    { job }: LifecycleJobContext,
    error: unknown
  ): Promise<LifecycleJobOutcome> {
    if (this.owner.closed()) return
    const { token } = readJob(job)
    if (job.fn === "recover") {
      await this.run(
        Effect.logError("Routine job exhausted", { job: job.id }, error)
      )
      if (this.owner.closed()) return
      const now = Date.now()
      const command = observeRoutineDiscovery(job.payload, {
        now,
        pending: false,
      }).find((command) => command.type === "reschedule")
      return this.outcome(
        job,
        command ? { rescheduleAt: command.at } : undefined
      )
    }
    const { permission, receipt } = await this.owner.ask((reply) => ({
      type: "ERROR",
      token,
      job,
      current: this.owns(job),
      reply,
    }))
    if (permission !== "start") return this.outcome(job, undefined)
    try {
      if (!receipt || this.owner.closed()) return this.outcome(job, undefined)
      await this.run(
        Effect.logError("Routine job exhausted", { job: job.id }, error)
      )
      await this.run(this.host.exhaust(receipt, () => this.owns(job)))
    } finally {
      await this.owner.acknowledge((ack) => ({
        type: "EXHAUSTED",
        token,
        job,
        ack,
      }))
      this.host.notify?.()
    }
    return this.outcome(job, undefined)
  }
  dispose() {
    return this.owner.dispose()
  }
}
