import {
  LifecycleCapability,
  type LifecycleJob,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from "agents/lifecycle"
import { Clock, Effect, Exit, Schema } from "effect"

import { armReplyRecovery, observeReplyRecovery } from "../recovery.machine"

const JobOwner = Schema.Struct({
  version: Schema.Literal(1),
  token: Schema.String.check(Schema.isNonEmpty()),
  peer: Schema.NullOr(Schema.String),
})

function jobOwner(job: LifecycleJob | undefined) {
  const payload = job?.payload
  if (typeof payload !== "object" || payload === null || !("owner" in payload))
    return undefined
  return Schema.decodeUnknownSync(JobOwner)(payload.owner)
}

/** Email and WhatsApp keep their existing capability IDs and one Lifecycle
 * alarm. Discovery schedules the ordinary channel pump; it never resends an
 * uncertain provider part. */
export class ReplyRunner<E> extends LifecycleCapability {
  constructor(
    readonly channel: "email" | "whatsapp",
    readonly host: {
      run: <A>(work: Effect.Effect<A, E>) => Promise<A>
      pump: () => Promise<LifecycleJobOutcome>
      recover: () => Effect.Effect<void, E>
      pending: () => Effect.Effect<readonly { state: string }[], E>
      /** Re-read eligibility inside the same synchronous domain transaction as
       * the exhaustion events; an observation made before entering it is stale. */
      exhaust: (
        eligible: () => boolean,
        expiredOnly: boolean
      ) => Effect.Effect<void, E>
      nextRecovery: () => Effect.Effect<number | undefined, E>
    }
  ) {
    super(channel)
  }

  private peerId(fn: string) {
    return `${this.channel}:${fn === "recover" ? "pump" : "reply-recovery"}`
  }
  private ownership(fn: string) {
    // A future persisted ownership format needs migration, not replacement.
    jobOwner(
      this.lifecycle.jobs.get(
        `${this.channel}:${fn === "recover" ? "reply-recovery" : "pump"}`
      )
    )
    return {
      version: 1 as const,
      token: crypto.randomUUID(),
      peer: jobOwner(this.lifecycle.jobs.get(this.peerId(fn)))?.token ?? null,
    }
  }
  private ownsFailure(job: LifecycleJob) {
    const owner = jobOwner(job)
    if (!owner) return false
    if (jobOwner(this.lifecycle.jobs.get(job.id))?.token !== owner.token)
      return false
    const peer = this.lifecycle.jobs.get(this.peerId(job.fn))
    // Admission prearms recovery before committing and waking the pump. Check
    // both owners so an old pump failure cannot consume that newer admission.
    return !peer || jobOwner(peer)?.token === owner.peer
  }
  /** Materialize retained orphan rows when storage returns. This is an
   * observation/terminalization path, never authorization to restart delivery. */
  async reconcile() {
    await this.host.run(
      this.host.exhaust(
        () =>
          !this.lifecycle.jobs.get(`${this.channel}:pump`) &&
          !this.lifecycle.jobs.get(`${this.channel}:reply-recovery`),
        true
      )
    )
    // A storage outage may leave a valid queue row but lose physical alarm
    // delivery. Rearm existing intent without creating another job or budget.
    await this.lifecycle.jobs.rearm()
  }
  async wake() {
    await this.lifecycle.jobs.push({
      id: `${this.channel}:pump`,
      fn: "pump",
      payload: { owner: this.ownership("pump") },
      time: Date.now(),
      singleflight: true,
      recoveryLoop: true,
      hungTimeoutSeconds: 600,
      retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
    })
  }
  async armReply(deadline: number) {
    const id = `${this.channel}:reply-recovery`
    const prior = this.lifecycle.jobs.get(id)
    const payload = armReplyRecovery(
      prior?.payload,
      prior?.time ?? deadline,
      deadline
    )
    await this.lifecycle.jobs.push({
      id,
      fn: "recover",
      payload: { ...payload, owner: this.ownership("recover") },
      time: Math.min(deadline, prior?.time ?? Infinity),
      singleflight: true,
      recoveryLoop: true,
      retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
    })
  }
  async onJobError(
    { job }: LifecycleJobContext,
    error: unknown
  ): Promise<LifecycleJobOutcome> {
    await this.host.run(
      Effect.logError(
        "Reply job exhausted",
        { channel: this.channel, job: job.id },
        error
      )
    )
    const now = await this.host.run(Clock.currentTimeMillis)
    const settled = await this.host.run(
      Effect.exit(
        Effect.gen({ self: this }, function* () {
          yield* this.host.exhaust(() => this.ownsFailure(job), false)
          return yield* this.host.nextRecovery()
        })
      )
    )
    if (Exit.isFailure(settled))
      await this.host.run(
        Effect.logError(
          "Reply recovery exhausted; terminal persistence is unconfirmed",
          { channel: this.channel, job: job.id },
          settled.cause
        )
      )
    if (job.fn !== "recover") return
    // A terminal storage outage cannot manufacture a committed result. Preserve
    // a still-fresh admission lease, but never silently renew an expired budget.
    // Return the outcome through Lifecycle so a concurrent newer push wins.
    const deadline = Exit.isSuccess(settled) ? (settled.value ?? null) : null
    for (const command of observeReplyRecovery(job.payload, job.time, {
      now,
      pending: false,
      deadline,
    }))
      if (command.type === "reschedule") return { rescheduleAt: command.at }
  }
  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    // Legacy jobs have no owner; future metadata must fail before domain work.
    jobOwner(job)
    if (job.fn !== "recover") return this.host.pump()
    const observation = await this.host.run(
      Effect.gen({ self: this }, function* () {
        // An admission may commit while this scan awaits storage. Retain its
        // lease using the time the scan began, even if the deadline passes
        // before the last read completes.
        const now = yield* Clock.currentTimeMillis
        yield* this.host.recover()
        // Settle expired preparation rows before deriving the next wake. A due
        // recovery job must not keep pushing its pump behind its own past deadline.
        yield* this.host.exhaust(() => true, true)
        const pending = (yield* this.host.pending()).some(
          (row) => row.state !== "sending"
        )
        const deadline = (yield* this.host.nextRecovery()) ?? null
        return { pending, deadline, now }
      })
    )
    let outcome: LifecycleJobOutcome
    for (const command of observeReplyRecovery(
      job.payload,
      job.time,
      observation
    )) {
      if (command.type === "wake") await this.wake()
      else outcome = { rescheduleAt: command.at }
    }
    return outcome
  }
}
