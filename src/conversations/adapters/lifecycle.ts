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
import { ConversationExecutionError } from "../execution"
import {
  armConversationDiscovery,
  observeConversationDiscovery,
  readConversationDiscovery,
} from "../recovery-discovery.machine"

const PumpOwner = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  token: Schema.String.check(Schema.isNonEmpty()),
})
export type { ConversationControlAttempt } from "../runner.machine"
import {
  conversationRunnerMachine,
  type ConversationControlAttempt,
  type ConversationRunnerDecision,
  type ConversationRunnerReply,
  type ConversationRunnerAck,
} from "../runner.machine"
type RunnerMachine = ReturnType<typeof conversationRunnerMachine>
const pumpId = "pump"
const discoveryId = "conversation-recovery"
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
    return readConversationDiscovery(job.payload)
  throw new Error(`Unsupported conversation job: ${job.id}/${job.fn}`)
}

/** Lifecycle owns durable scheduling. This adapter only retains admission
 * discovery and correlates a bounded failed dispatch with its domain claim. */
export class ConversationRunner<E> extends LifecycleCapability {
  private readonly scope = Scope.makeUnsafe()
  private actor?: EffectActor<RunnerMachine>
  private readonly operations = new Set<Promise<unknown>>()
  private closing?: Promise<void>

  constructor(
    readonly host: {
      run: <A>(work: Effect.Effect<A, E>) => Promise<A>
      step: (
        onAttempt: (attempt: ConversationControlAttempt) => void
      ) => Promise<number | undefined>
      /** Re-read eligibility inside the same synchronous domain transaction as
       * the exact root/revision exhaustion event. Never exhaust an owned row. */
      exhaust: (
        attempt: ConversationControlAttempt,
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
    super("personal-chat")
  }

  private getActor() {
    // Lazy creation preserves Lifecycle's first native caller context.
    return (this.actor ??= Effect.runSync(
      createEffectActor(
        conversationRunnerMachine(() =>
          nativeOperation(
            () => this.host.run(this.host.restore()),
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
    event: (reply: ConversationRunnerReply) => EventFromLogic<RunnerMachine>
  ) {
    const reply = Deferred.makeUnsafe<ConversationRunnerDecision>()
    Effect.runSync(send(this.getActor(), event(reply)))
    return Effect.runPromise(Deferred.await(reply))
  }
  private acknowledge(
    event: (ack: ConversationRunnerAck) => EventFromLogic<RunnerMachine>
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
  armDiscovery(): Promise<number> {
    return this.track(() =>
      this.schedule(async () => {
        const now = Date.now(),
          deadline = now + discoveryDuration
        const prior = this.current(discoveryId)
        const payload = armConversationDiscovery(
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
    ).then((deadline) => {
      if (deadline === undefined || this.closed())
        throw new Error("Conversation runner is stopped")
      return deadline
    })
  }
  wake() {
    return this.track(() =>
      this.schedule(async () => {
        const current = this.current(pumpId)
        const { permission } = await this.ask((reply) => ({
          type: "WAKE",
          token: current ? readJob(current).token : null,
          reply,
        }))
        if (this.closed()) return
        if (permission === "empty") await this.pushPump(Date.now())
        else if (permission === "rearm") await this.lifecycle.jobs.rearm()
        else if (permission === "schedule")
          await this.lifecycle.jobs.reschedule(pumpId, Date.now())
      })
    )
  }
  reconcile() {
    return this.track(async () => {
      if (this.closed()) return
      this.current(pumpId)
      this.current(discoveryId)
      await this.restore()
      await this.schedule(async () => {
        if (!this.current(pumpId) && !this.current(discoveryId)) {
          const next = await this.host.run(this.host.nextWake())
          if (!this.closed() && next !== undefined && !this.current(pumpId))
            await this.pushPump(next)
        }
        if (!this.closed()) await this.lifecycle.jobs.rearm()
      })
    })
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
    if (job.fn === "recover") {
      // Capture scan start before storage: admission may commit while it waits.
      const now = await this.host.run(Clock.currentTimeMillis)
      const pending = (await this.host.run(this.host.nextWake())) !== undefined
      let outcome: LifecycleJobOutcome
      for (const command of observeConversationDiscovery(job.payload, {
        now,
        pending,
      })) {
        if (command.type === "wake") await this.wake()
        else outcome = { rescheduleAt: command.at }
      }
      return this.outcome(job, outcome)
    }
    const { permission } = await this.ask((reply) => ({
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
    if (this.closed() || !this.owns(job)) {
      await this.ask((reply) => ({ type: "FINISHED", token, job, reply }))
      return this.outcome(job, undefined)
    }
    try {
      const next = await this.host.step((receipt) => {
        // Receipt observation occurs after the domain claim transaction. Enqueue
        // synchronously so completion cannot overtake this exact receipt.
        Effect.runSync(
          send(this.getActor(), { type: "RECEIPT", token, job, receipt })
        )
      })
      const result = await this.ask((reply) => ({
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
      await this.acknowledge((ack) => ({ type: "FAILED", token, job, ack }))
      throw error
    } finally {
      this.host.notify?.()
    }
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
    if (job.fn === "recover") {
      await this.host.run(
        Effect.logError("Conversation job exhausted", { job: job.id }, error)
      )
      if (this.closed()) return
      const now = await this.host.run(Clock.currentTimeMillis)
      const command = observeConversationDiscovery(job.payload, {
        now,
        pending: false,
      }).find((command) => command.type === "reschedule")
      return this.outcome(
        job,
        command ? { rescheduleAt: command.at } : undefined
      )
    }
    const { permission, receipt } = await this.ask((reply) => ({
      type: "ERROR",
      token,
      job,
      current: this.owns(job),
      reply,
    }))
    if (permission !== "start") return this.outcome(job, undefined)
    try {
      if (!receipt || this.closed()) return this.outcome(job, undefined)
      await this.host.run(
        Effect.logError("Conversation job exhausted", { job: job.id }, error)
      )
      const result = await this.host.run(
        Effect.exit(this.host.exhaust(receipt, error, () => this.owns(job)))
      )
      if (Exit.isSuccess(result) && !result.value && !this.closed()) {
        // A newer Stop or explicit recovery still owns its revisioned wake.
        const next = await this.host.run(this.host.nextWake())
        if (next !== undefined) return this.outcome(job, { rescheduleAt: next })
      }
      if (Exit.isFailure(result)) {
        if (this.closed()) throw result.cause
        await this.host.run(
          Effect.logError(
            "Conversation control persistence is unconfirmed",
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

/** Observe only Conversation-owned scheduling. A late arm or doorbell can add
 * a redundant Lifecycle wake; it cannot admit a turn, submit to Pi or confirm Stop.
 * Unlike native handoff/resource cleanup this value-only operation must not
 * hold authority revocation hostage while waiting for jobs.push to settle.
 * Domain admission still checks the returned lease in its final transaction. */
export const observeConversationSchedule = <A>(
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
          const declared = Schema.decodeUnknownOption(
            ConversationExecutionError
          )(failure)
          if (declared._tag === "Some") return declared.value
          if (channel === "failure" || Schema.isSchemaError(failure))
            throw failure
          return new ConversationExecutionError({
            operation,
            cause: failure,
          })
        }),
    }).pipe(Effect.catch((cause) => Effect.failCause(cause)))
  }).pipe(
    Effect.timeoutOrElse({
      duration: 5000,
      orElse: () =>
        Effect.fail(
          new ConversationExecutionError({
            operation,
            cause:
              "Conversation scheduling did not respond within five seconds.",
          })
        ),
    }),
    // Stop itself remains uninterruptible so it can finish durable revocation;
    // its bounded, value-only prearm observation has an interruptible subscope.
    Effect.interruptible
  )
