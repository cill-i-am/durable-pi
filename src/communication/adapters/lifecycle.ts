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
import {
  CommunicationError,
  failure,
  type ControlAttempt,
  type MailboxRecovery,
} from "../contracts"
import {
  armCommunicationDiscovery,
  observeCommunicationDiscovery,
  readCommunicationDiscovery,
  readMailboxRecoveryState,
  transitionMailboxRecovery,
} from "../recovery.machine"

const PumpOwner = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  token: Schema.String.check(Schema.isNonEmpty()),
})
export type CommunicationControlAttempt = ControlAttempt

import {
  communicationRunnerMachine,
  type CommunicationRunnerDecision,
  type CommunicationRunnerReply,
  type CommunicationRunnerAck,
} from "../runner.machine"
type RunnerMachine = ReturnType<typeof communicationRunnerMachine>
const pumpId = "bot-communication:pump"
const discoveryId = "bot-communication:recovery"
const recoveryKey = "bot-communication:failure"
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
    return readCommunicationDiscovery(job.payload)
  throw new Error(`Unsupported communication job: ${job.id}/${job.fn}`)
}

/** Lifecycle owns durable scheduling. This adapter only retains admission
 * discovery and correlates a bounded failed dispatch with its domain claim. */
export class CommunicationRunner<E> extends LifecycleCapability {
  private readonly scope = Scope.makeUnsafe()
  private actor?: EffectActor<RunnerMachine>
  private readonly operations = new Set<Promise<unknown>>()
  private closing?: Promise<void>

  constructor(
    readonly host: {
      run: <A>(work: Effect.Effect<A, E>) => Promise<A>
      step: (
        onAttempt: (attempt: CommunicationControlAttempt | undefined) => void
      ) => Promise<number | undefined>
      /** Re-read eligibility inside the same synchronous domain transaction as
       * the exact root/revision exhaustion event. Never exhaust an owned row. */
      exhaust: (
        attempt: CommunicationControlAttempt,
        error: unknown,
        eligible: () => boolean
      ) => Effect.Effect<boolean, E>
      /** Called once per cold runner. Domain restoration retains uncertainty;
       * it may inspect native receipts, but cannot grant another submission. */
      restore: () => Effect.Effect<void, E>
      nextWake: () => Effect.Effect<number | undefined, E>
      notify?: () => void
    }
  ) {
    super("bot-communication")
  }

  private async run<A>(work: Effect.Effect<A, E>): Promise<A> {
    // The native runner squashes failed Exits. Keep the whole Exit as its
    // successful value until this boundary can return every original reason.
    const exit = await this.host.run(Effect.exit(work))
    if (Exit.isFailure(exit)) throw exit.cause
    return exit.value
  }
  private getActor() {
    // Lazy creation preserves Lifecycle's first native caller context.
    return (this.actor ??= Effect.runSync(
      createEffectActor(
        communicationRunnerMachine(() =>
          nativeOperation(
            () => this.run(this.host.restore()),
            (cause) => cause
          )
        )
      ).pipe(Scope.provide(this.scope))
    ))
  }
  private closed() {
    // Eligibility may be read inside native SQL; never start an actor there.
    return this.actor?.getSnapshot().matches({ admission: "closed" }) ?? false
  }
  private track<A>(work: () => Promise<A>) {
    this.getActor()
    const pending = work()
    this.operations.add(pending)
    void pending.then(
      () => this.operations.delete(pending),
      () => this.operations.delete(pending)
    )
    return pending
  }
  private ask(
    event: (reply: CommunicationRunnerReply) => EventFromLogic<RunnerMachine>
  ) {
    const reply = Deferred.makeUnsafe<CommunicationRunnerDecision>()
    Effect.runSync(send(this.getActor(), event(reply)))
    return Effect.runPromise(Deferred.await(reply))
  }
  private acknowledge(
    event: (ack: CommunicationRunnerAck) => EventFromLogic<RunnerMachine>
  ) {
    const ack = Deferred.makeUnsafe<void>()
    Effect.runSync(send(this.getActor(), event(ack)))
    return Effect.runPromise(Deferred.await(ack))
  }
  private async restore() {
    const actor = this.getActor(),
      snapshot = actor.getSnapshot()
    const reply = Deferred.makeUnsafe<void, unknown>()
    const generation =
      snapshot.context.generation +
      (snapshot.matches({ activation: "cold" }) ? 1 : 0)
    Effect.runSync(send(actor, { type: "RESTORE", reply, generation }))
    const exit = await Effect.runPromiseExit(Deferred.await(reply))
    if (Exit.isFailure(exit)) throw exit.cause
  }
  private async schedule<A>(work: () => Promise<A>): Promise<A | undefined> {
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
  private current(id: string) {
    const job = this.lifecycle.jobs.get(id)
    if (job) readJob(job)
    return job
  }
  private owns(job: LifecycleJob) {
    if (this.closed()) return false
    const latest = this.current(job.id)
    return !!latest && readJob(latest).token === readJob(job).token
  }
  private outcome(job: LifecycleJob, outcome: LifecycleJobOutcome) {
    if (this.closed()) return
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
  armDiscovery(recoveryEpoch?: string): Promise<number> {
    return this.track(() => this.schedule(() => this.arm(recoveryEpoch))).then(
      (deadline) => {
        if (deadline === undefined || this.closed())
          throw new Error("Communication runner is stopped")
        return deadline
      }
    )
  }
  private async arm(recoveryEpoch?: string): Promise<number> {
    const now = Date.now()
    const deadline = now + discoveryDuration
    const prior = this.current(discoveryId)
    const payload = armCommunicationDiscovery(
      prior?.payload,
      deadline,
      crypto.randomUUID(),
      recoveryEpoch
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
  }
  private async persistFailure() {
    const completed = this.getActor().getSnapshot().context.failure
    if (!completed) return
    await this.lifecycle.storage.transaction(async (storage) => {
      const prior = readMailboxRecoveryState(await storage.get(recoveryKey))
      // A joined failed epoch can be retried after its SDK row was removed,
      // but cannot replace a newer pump or a newer durable failure summary.
      const current = this.current(completed.jobId)
      if (
        (current && readJob(current).token !== completed.recovery.epoch) ||
        prior.retiredEpoch === completed.recovery.epoch ||
        (!current &&
          prior.recovery &&
          prior.recovery.epoch !== completed.recovery.epoch)
      )
        return
      await storage.put(
        recoveryKey,
        transitionMailboxRecovery(prior, {
          type: "EXHAUSTED",
          recovery: completed.recovery,
        })
      )
    })
    await this.acknowledge((ack) => ({
      type: "FAILURE_PERSISTED",
      key: completed.key,
      ack,
    }))
    const discovery = this.current(discoveryId)
    if (
      discovery &&
      readJob(discovery).token === completed.recovery.discoveryToken
    )
      await this.lifecycle.jobs.cancel(discoveryId)
  }
  private async recoveryState() {
    await this.persistFailure()
    return readMailboxRecoveryState(
      await this.lifecycle.storage.get(recoveryKey)
    )
  }
  recovery(): Promise<MailboxRecovery | null> {
    return this.track(async () => {
      if (this.closed()) throw new Error("Communication runner is stopped")
      return (await this.recoveryState()).recovery
    })
  }
  private mayWake(recovery: MailboxRecovery | null) {
    const discovery = this.current(discoveryId)
    if (!recovery) return true
    if (!discovery) return false
    const lease = readCommunicationDiscovery(discovery.payload)
    // A recovery prearm only retains discovery. It cannot authorize a new
    // epoch until the exact failed summary has been cleared transactionally.
    return !lease.recoveryEpoch && lease.token !== recovery.discoveryToken
  }
  async armRecovery(epoch: string): Promise<number> {
    if ((await this.recovery())?.epoch !== epoch)
      throw failure(
        "conflict",
        "This mailbox failure has changed. Reload its current status."
      )
    return this.armDiscovery(epoch)
  }
  retryRecovery(epoch: string, deadline: number): Promise<void> {
    return this.track(async () => {
      if (this.closed()) throw new Error("Communication runner is stopped")
      await this.retry(epoch, deadline)
    })
  }
  private async retry(epoch: string, deadline: number): Promise<void> {
    await this.persistFailure()
    await this.lifecycle.storage.transaction(async (storage) => {
      const prior = readMailboxRecoveryState(await storage.get(recoveryKey))
      const discovery = this.current(discoveryId)
      const now = Date.now()
      if (prior.recovery?.epoch !== epoch)
        throw failure(
          "conflict",
          "This mailbox failure has changed. Reload its current status."
        )
      if (
        !discovery ||
        readCommunicationDiscovery(discovery.payload).recoveryEpoch !== epoch ||
        readCommunicationDiscovery(discovery.payload).armedUntil < deadline ||
        now >= deadline
      )
        throw failure(
          "storage",
          "Mailbox recovery discovery expired. Retry the same recovery."
        )
      const next = transitionMailboxRecovery(prior, {
        type: "RETRY",
        epoch,
        now,
        deadline,
        pumpEpoch: this.current(pumpId)
          ? readJob(this.current(pumpId)!).token
          : null,
      })
      if (next.recovery)
        throw failure("conflict", "Mailbox recovery was not accepted.")
      await storage.put(recoveryKey, next)
    })
  }
  wake() {
    return this.track(() => this.schedule(() => this.wakeQueue()))
  }
  private async wakeQueue() {
    const state = await this.recoveryState()
    if (this.closed()) return
    const recovery = state.recovery
    const allowed = this.mayWake(recovery)
    const current = this.current(pumpId)
    if (!current) {
      if (allowed) return this.pushPump(Date.now())
      return
    }
    if (!allowed) return
    if (
      readJob(current).token === recovery?.epoch ||
      readJob(current).token === state.retiredEpoch
    )
      return this.pushPump(Date.now())
    const { permission } = await this.ask((reply) => ({
      type: "WAKE",
      token: readJob(current).token,
      reply,
    }))
    if (this.closed()) return
    if (permission === "rearm") await this.lifecycle.jobs.rearm()
    else if (permission === "schedule")
      await this.lifecycle.jobs.reschedule(pumpId, Date.now())
  }
  reconcile() {
    return this.track(async () => {
      if (this.closed()) return
      this.current(pumpId)
      this.current(discoveryId)
      await this.restore()
      await this.schedule(() => this.reconcilePending())
    })
  }
  reconcileQueue() {
    return this.track(() => this.schedule(() => this.reconcilePending()))
  }
  private async reconcilePending() {
    const recovery = (await this.recoveryState()).recovery
    if (this.closed()) return
    const allowed = this.mayWake(recovery)
    const pump = this.current(pumpId)
    const discovery = this.current(discoveryId)
    if (allowed && !pump && !discovery) {
      const next = await this.run(this.host.nextWake())
      // No awaited work lies between this second absence check and push.
      if (!this.closed() && next !== undefined && !this.current(pumpId))
        await this.pushPump(next)
    }
    if (!this.closed()) await this.lifecycle.jobs.rearm()
  }
  onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    return this.track(() => this.dispatch(context))
  }
  private async dispatch({
    job,
  }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (this.closed()) return
    const { token } = readJob(job)
    if (!this.owns(job)) return this.outcome(job, undefined)
    const discovery = this.current(discoveryId)
    const { permission } = await this.ask((reply) => ({
      type: "ADMIT",
      token,
      job,
      current: this.owns(job),
      discoveryToken: discovery ? readJob(discovery).token : null,
      reply,
    }))
    if (permission === "stopped") return
    if (permission !== "start")
      return this.outcome(
        job,
        permission === "defer" ? { rescheduleAt: Date.now() + 1000 } : undefined
      )
    try {
      const outcome =
        this.closed() || !this.owns(job)
          ? undefined
          : job.fn === "recover"
            ? await this.discover(job)
            : await this.pump(job, token)
      const result = await this.ask((reply) => ({
        type: "FINISHED",
        token,
        job,
        reply,
      }))
      return this.outcome(
        job,
        job.fn === "pump" && result.permission === "rearm"
          ? {
              rescheduleAt: Math.min(
                typeof outcome === "object" ? outcome.rescheduleAt : Infinity,
                Date.now()
              ),
            }
          : outcome
      )
    } catch (error) {
      await this.acknowledge((ack) => ({ type: "FAILED", token, job, ack }))
      throw error
    } finally {
      this.host.notify?.()
    }
  }
  private async discover(job: LifecycleJob): Promise<LifecycleJobOutcome> {
    if (!this.mayWake((await this.recoveryState()).recovery)) {
      const lease = readCommunicationDiscovery(job.payload)
      return lease.recoveryEpoch && lease.armedUntil > Date.now()
        ? { rescheduleAt: lease.armedUntil }
        : undefined
    }
    if (!this.owns(job)) return
    // Capture scan start before storage: admission may commit while it waits.
    const now = await this.run(Clock.currentTimeMillis)
    const pending = (await this.run(this.host.nextWake())) !== undefined
    let outcome: LifecycleJobOutcome
    for (const command of observeCommunicationDiscovery(job.payload, {
      now,
      pending,
    })) {
      if (command.type === "wake") await this.wake()
      else outcome = { rescheduleAt: command.at }
    }
    return outcome
  }
  private async pump(
    job: LifecycleJob,
    token: string
  ): Promise<LifecycleJobOutcome> {
    const state = await this.recoveryState()
    if (
      !this.owns(job) ||
      state.recovery?.epoch === token ||
      state.retiredEpoch === token
    )
      return
    const next = await this.host.step((receipt) => {
      // The claim transaction has completed. Enqueue its observation before
      // callback completion; undefined clears the previous attempt's receipt.
      Effect.runSync(
        send(this.getActor(), {
          type: "RECEIPT",
          token,
          job,
          receipt: receipt ?? null,
        })
      )
    })
    return next === undefined ? undefined : { rescheduleAt: next }
  }
  onJobError(
    context: LifecycleJobContext,
    error: unknown
  ): Promise<LifecycleJobOutcome> {
    return this.track(() => this.failed(context, error))
  }
  private async failed(
    { job }: LifecycleJobContext,
    error: unknown
  ): Promise<LifecycleJobOutcome> {
    if (this.closed()) return
    const { token } = readJob(job)
    const { permission, receipt, discoveryToken } = await this.ask((reply) => ({
      type: "ERROR",
      token,
      job,
      current: this.owns(job),
      reply,
    }))
    if (permission !== "start") return this.outcome(job, undefined)
    try {
      if (this.closed()) return
      await this.run(
        Effect.logError("Communication job exhausted", { job: job.id }, error)
      )
      if (job.fn === "recover" || !receipt) {
        if (this.owns(job)) {
          await this.acknowledge((ack) => ({
            type: "RETAIN_FAILURE",
            ack,
            failure: {
              key: crypto.randomUUID(),
              jobId: job.id,
              recovery: {
                schemaVersion: 1,
                workflowVersion: 1,
                epoch: token,
                failedAt: Date.now(),
                discoveryToken: job.fn === "recover" ? token : discoveryToken,
                message:
                  job.fn === "recover"
                    ? "Mailbox discovery stopped after three failed attempts. Retry the mailbox to continue pending work."
                    : "Mailbox processing stopped after three failed attempts. Retry the mailbox to continue pending work.",
              },
            },
          }))
          await this.persistFailure()
        }
        return this.outcome(job, undefined)
      }
      const result = await this.run(
        Effect.exit(this.host.exhaust(receipt, error, () => this.owns(job)))
      )
      if (Exit.isSuccess(result) && !result.value && !this.closed()) {
        const next = await this.run(this.host.nextWake())
        if (next !== undefined) return this.outcome(job, { rescheduleAt: next })
      }
      if (Exit.isFailure(result)) {
        if (this.closed()) throw result.cause
        await this.run(
          Effect.logError(
            "Communication control persistence is unconfirmed",
            result.cause
          )
        )
      }
    } finally {
      await this.acknowledge((ack) => ({ type: "EXHAUSTED", token, job, ack }))
      this.host.notify?.()
    }
    return this.outcome(job, undefined)
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

/** Observe only Communication-owned scheduling. A late arm or doorbell can add
 * a redundant Lifecycle wake; it cannot admit a turn, submit to Pi or confirm Stop.
 * Unlike native handoff/resource cleanup this value-only operation must not
 * hold authority revocation hostage while waiting for jobs.push to settle.
 * Domain admission still checks the returned lease in its final transaction. */
export const observeCommunicationSchedule = <A>(
  operation: string,
  start: () => Promise<A>
) =>
  Effect.suspend(() => {
    // Calling outside tryPromise preserves synchronous throws as defects.
    const pending = start()
    return Effect.tryPromise({
      try: () => pending,
      catch: (cause) =>
        nativeFailure(cause, (failure, channel) => {
          const declared =
            Schema.decodeUnknownOption(CommunicationError)(failure)
          if (declared._tag === "Some") return declared.value
          if (channel === "failure" || Schema.isSchemaError(failure))
            throw failure
          return new CommunicationError({
            code: "storage",
            message: `${operation}: communication scheduling could not be confirmed.`,
          })
        }),
    }).pipe(Effect.catch((cause) => Effect.failCause(cause)))
  }).pipe(
    Effect.timeoutOrElse({
      duration: 5000,
      orElse: () =>
        Effect.fail(
          failure(
            "storage",
            `${operation}: communication scheduling did not respond within five seconds.`
          )
        ),
    }),
    // Stop itself remains uninterruptible so it can finish durable revocation;
    // its bounded, value-only prearm observation has an interruptible subscope.
    Effect.interruptible
  )
