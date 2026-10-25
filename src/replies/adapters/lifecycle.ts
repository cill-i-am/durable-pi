import { createEffectActor, send, type EffectActor } from "@xstate/effect"
import {
  LifecycleCapability,
  type LifecycleJob,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from "agents/lifecycle"
import { Cause, Clock, Deferred, Effect, Exit, Schema, Scope } from "effect"

import { armReplyRecovery, observeReplyRecovery } from "../recovery.machine"
import { replyRunnerLifetime } from "../reply-runner.machine"

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
  private readonly scope = Scope.makeUnsafe()
  private actor?: EffectActor<typeof replyRunnerLifetime>
  private readonly operations = new Set<Promise<unknown>>()
  private closing?: Promise<void>
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

  private async run<A>(work: Effect.Effect<A, E>): Promise<A> {
    const exit = await this.host.run(Effect.exit(work))
    if (Exit.isFailure(exit)) throw exit.cause
    return exit.value
  }
  private getActor() {
    return (this.actor ??= Effect.runSync(
      createEffectActor(replyRunnerLifetime).pipe(Scope.provide(this.scope))
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
    if (this.closed()) return false
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
  reconcile() {
    return this.track(async () => {
      if (!this.closed()) await this.reconcileQueue()
    })
  }
  private async reconcileQueue() {
    await this.run(
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
  wake() {
    return this.track(async () => {
      if (!this.closed()) await this.wakeQueue()
    })
  }
  private async wakeQueue() {
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
  armReply(deadline: number) {
    return this.track(async () => {
      if (this.closed()) return false
      await this.arm(deadline)
      return true
    }).then((armed) => {
      if (!armed || this.closed()) throw new Error("Reply runner is stopped")
    })
  }
  private async arm(deadline: number) {
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
      Effect.logError(
        "Reply job exhausted",
        { channel: this.channel, job: job.id },
        error
      )
    )
    const now = await this.run(Clock.currentTimeMillis)
    const settled = await this.run(
      Effect.exit(
        Effect.gen({ self: this }, function* () {
          yield* this.host.exhaust(() => this.ownsFailure(job), false)
          return yield* this.host.nextRecovery()
        })
      )
    )
    if (Exit.isFailure(settled) && this.closed()) throw settled.cause
    if (Exit.isFailure(settled))
      await this.run(
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
  onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    return this.track(async () =>
      this.closed() ? undefined : this.dispatch(context)
    )
  }
  private async dispatch({
    job,
  }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    // Legacy jobs have no owner; future metadata must fail before domain work.
    jobOwner(job)
    if (job.fn !== "recover") return this.host.pump()
    const observation = await this.run(
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
