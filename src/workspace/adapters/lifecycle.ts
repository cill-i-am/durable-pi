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
  observeWorkspaceDiscovery,
  readWorkspacePump,
  WorkspacePreparationClaim,
  type WorkspacePump,
} from "../discovery.machine"
import { WorkspaceUnavailable } from "../files"
import {
  workspaceRunnerMachine,
  type WorkspaceRunnerDecision,
  type WorkspaceRunnerReply,
  type WorkspaceRunnerAck,
} from "../runner.machine"
import type { PreparationClaim } from "../workspace"
import {
  workspacePumpId as pumpId,
  workspaceDiscoveryId as discoveryId,
  readWorkspaceJob as readJob,
  workspacePumpJob,
  workspaceDiscoveryJob,
  workspaceJobOutcome,
} from "./runner-jobs"
type RunnerMachine = ReturnType<typeof workspaceRunnerMachine>
type Result = { outcome: LifecycleJobOutcome; retain: boolean }
/** Lifecycle owns the only alarm and its three transport attempts. Preparation
 * owns native scope joining, business attempts and persisted recovery deadlines. */
export class WorkspaceRunner<E> extends LifecycleCapability {
  private readonly scope = Scope.makeUnsafe()
  private actor?: EffectActor<RunnerMachine>
  private readonly operations = new Set<Promise<unknown>>()
  private closing?: Promise<void>
  constructor(
    readonly host: {
      run: <A>(work: Effect.Effect<A, E>) => Promise<A>
      step: (
        onClaim: (
          claim: PreparationClaim
        ) => Effect.Effect<void, WorkspaceUnavailable>
      ) => Promise<number | undefined>
      restore: () => Effect.Effect<void, E>
      nextWake: () => Effect.Effect<number | undefined, E>
      exhaust: (
        claim: PreparationClaim | undefined,
        current: () => boolean
      ) => Effect.Effect<number | undefined, E>
      notify?: () => void
    }
  ) {
    super("workspace-extraction")
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
        workspaceRunnerMachine(() =>
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
    event: (reply: WorkspaceRunnerReply) => EventFromLogic<RunnerMachine>
  ) {
    const reply = Deferred.makeUnsafe<WorkspaceRunnerDecision>()
    Effect.runSync(send(this.getActor(), event(reply)))
    return Effect.runPromise(Deferred.await(reply))
  }
  private acknowledge(
    event: (ack: WorkspaceRunnerAck) => EventFromLogic<RunnerMachine>
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
    const current = this.current(job.id)
    return !!current && readJob(current).token === readJob(job).token
  }
  private outcome(job: LifecycleJob, result: LifecycleJobOutcome) {
    if (this.closed()) return
    return workspaceJobOutcome(this.current(job.id), job, result)
  }
  private pushPump(time: number, payload?: WorkspacePump) {
    return this.lifecycle.jobs.push(workspacePumpJob(time, payload))
  }
  armDiscovery(): Promise<number> {
    return this.track(() => this.schedule(() => this.arm())).then(
      (deadline) => {
        if (deadline === undefined || this.closed())
          throw new Error("Workspace runner is stopped")
        return deadline
      }
    )
  }
  private async arm(): Promise<number> {
    const now = Date.now()
    const { job, deadline } = workspaceDiscoveryJob(
      this.current(discoveryId),
      now,
      crypto.randomUUID()
    )
    await this.lifecycle.jobs.push(job)
    return deadline
  }
  wake() {
    return this.track(() =>
      this.schedule(async () => {
        const current = this.current(pumpId),
          payload = current ? readJob(current) : undefined
        const { permission } = await this.ask((reply) => ({
          type: "WAKE",
          token: payload?.token ?? null,
          cleanup:
            !!payload && "phase" in payload && payload.phase !== "dispatch",
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
          const next = await this.run(this.host.nextWake())
          if (!this.closed() && next !== undefined && !this.current(pumpId))
            await this.pushPump(next)
        }
        if (!this.closed()) await this.lifecycle.jobs.rearm()
      })
    })
  }
  private async finishCleanup(
    job: LifecycleJob,
    state: WorkspacePump
  ): Promise<Result> {
    const deadline = await this.run(
      this.host.exhaust(state.claim ?? undefined, () => this.owns(job))
    )
    if (!this.owns(job)) return { outcome: undefined, retain: true }
    if (!state.claim && deadline !== undefined && !state.finalBatch) {
      const { pump } = await this.ask((reply) => ({
        type: "DEFER_CLEANUP",
        token: state.token,
        job,
        at: deadline,
        reply,
      }))
      if (!pump) throw new Error("Workspace cleanup receipt is missing")
      if (this.closed()) return { outcome: undefined, retain: true }
      await this.pushPump(deadline, pump)
      return { outcome: { rescheduleAt: deadline }, retain: false }
    }
    const next = await this.run(this.host.nextWake())
    if (!this.owns(job)) return { outcome: undefined, retain: true }
    if (next !== undefined) await this.pushPump(next)
    return { outcome: undefined, retain: false }
  }
  private async discover(job: LifecycleJob): Promise<LifecycleJobOutcome> {
    const now = await this.run(Clock.currentTimeMillis)
    await this.restore()
    const pending = (await this.run(this.host.nextWake())) !== undefined
    let result: LifecycleJobOutcome
    for (const command of observeWorkspaceDiscovery(job.payload, {
      now,
      pending,
    })) {
      if (command.type === "wake") {
        if (this.owns(job)) await this.wake()
      } else result = { rescheduleAt: command.at }
    }
    return this.outcome(job, result)
  }
  private async pump(job: LifecycleJob, state: WorkspacePump): Promise<Result> {
    await this.restore()
    if (!this.owns(job))
      return {
        outcome: undefined,
        retain: state.phase !== "dispatch" || !!state.claim,
      }
    if (state.phase === "retired") return { outcome: undefined, retain: false }
    if (state.phase === "cleanup") {
      if (state.finalBatch && Date.now() < state.cleanupAt)
        return { outcome: { rescheduleAt: state.cleanupAt }, retain: true }
      return this.finishCleanup(job, state)
    }
    const next = await this.host.step((claim) =>
      Effect.gen({ self: this }, function* () {
        // Preparation has already committed its claim transaction. Validate before
        // enqueuing so a malformed event cannot leave its acknowledgement waiting.
        yield* Effect.sync(() =>
          Schema.decodeUnknownSync(WorkspacePreparationClaim)(claim)
        )
        yield* Effect.promise(() =>
          this.acknowledge((ack) => ({
            type: "CLAIMED",
            token: state.token,
            job,
            claim,
            ack,
          }))
        )
        if (!this.owns(job))
          return yield* Effect.fail(new WorkspaceUnavailable({}))
      })
    )
    return {
      outcome: next === undefined ? undefined : { rescheduleAt: next },
      retain: false,
    }
  }
  onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    return this.track(() => this.dispatch(context))
  }
  private async dispatch({
    job,
  }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (this.closed()) return
    const payload = readJob(job)
    if (!this.owns(job)) return this.outcome(job, undefined)
    const decision = await this.ask((reply) => ({
      type: "ADMIT",
      token: payload.token,
      job,
      current: this.owns(job),
      pump: job.fn === "pump" ? readWorkspacePump(payload) : null,
      now: Date.now(),
      reply,
    }))
    if (decision.permission !== "start")
      return this.outcome(
        job,
        decision.permission === "defer"
          ? { rescheduleAt: decision.at }
          : undefined
      )
    try {
      const result = this.closed()
        ? { outcome: undefined, retain: true }
        : decision.pump
          ? await this.pump(job, decision.pump)
          : { outcome: await this.discover(job), retain: false }
      const finished = await this.ask((reply) => ({
        type: "FINISHED",
        token: payload.token,
        job,
        retain: result.retain,
        reply,
      }))
      return this.outcome(
        job,
        decision.pump?.phase === "dispatch" &&
          !result.retain &&
          finished.permission === "rearm"
          ? {
              rescheduleAt: Math.min(
                typeof result.outcome === "object"
                  ? result.outcome.rescheduleAt
                  : Infinity,
                Date.now()
              ),
            }
          : result.outcome
      )
    } catch (error) {
      await this.acknowledge((ack) => ({
        type: "FAILED",
        token: payload.token,
        job,
        now: Date.now(),
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
    return this.track(() => this.failed(context, error))
  }
  private async failed(
    { job }: LifecycleJobContext,
    error: unknown
  ): Promise<LifecycleJobOutcome> {
    if (this.closed()) return
    const payload = readJob(job)
    const decision = await this.ask((reply) => ({
      type: "ERROR",
      token: payload.token,
      job,
      current: this.owns(job),
      pump: job.fn === "pump" ? readWorkspacePump(payload) : null,
      now: Date.now(),
      reply,
    }))
    if (decision.permission !== "start")
      return this.outcome(
        job,
        decision.permission === "defer"
          ? { rescheduleAt: decision.at }
          : undefined
      )
    try {
      const result = decision.pump
        ? await this.exhaustBudget(job, decision.pump, error)
        : {
            outcome: observeWorkspaceDiscovery(job.payload, {
              now: Date.now(),
              pending: false,
            })
              .filter((command) => command.type === "reschedule")
              .map((command) => ({ rescheduleAt: command.at }))[0],
            retain: false,
          }
      await this.ask((reply) => ({
        type: "FINISHED",
        token: payload.token,
        job,
        retain: result.retain,
        reply,
      }))
      return this.outcome(job, result.outcome)
    } catch (cause) {
      await this.ask((reply) => ({
        type: "FINISHED",
        token: payload.token,
        job,
        retain: true,
        reply,
      }))
      throw cause
    }
  }
  private async exhaustBudget(
    job: LifecycleJob,
    next: WorkspacePump,
    error: unknown
  ): Promise<Result> {
    // Logging cannot erase a retained cleanup receipt if the runtime fails.
    try {
      await this.run(
        Effect.logError(
          "Workspace preparation job exhausted",
          { job: job.id, claim: next.claim, finalBatch: next.finalBatch },
          error
        )
      )
    } catch {
      /* Native recovery remains authoritative. */
    }
    this.host.notify?.()
    if (!this.owns(job)) return { outcome: undefined, retain: true }
    if (next.phase === "retired") return { outcome: undefined, retain: false }
    try {
      await this.pushPump(next.cleanupAt, next)
      return { outcome: { rescheduleAt: next.cleanupAt }, retain: false }
    } catch (cause) {
      // A failed payload write retains its warm claim and finite cleanup budget.
      if (this.closed()) throw cause
      return { outcome: { rescheduleAt: next.cleanupAt }, retain: true }
    }
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

/** Value-only schedule observation is bounded; native extraction cleanup is not
 * detached. Preserve Cause reasons rather than turning defects into retries. */
export const observeWorkspaceSchedule = <A>(
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
            Schema.decodeUnknownOption(WorkspaceUnavailable)(failure)
          if (declared._tag === "Some") return declared.value
          if (channel === "failure" || Schema.isSchemaError(failure))
            throw failure
          return new WorkspaceUnavailable({})
        }),
    }).pipe(Effect.catch((cause) => Effect.failCause(cause)))
  }).pipe(
    Effect.timeoutOrElse({
      duration: 5000,
      orElse: () => Effect.fail(new WorkspaceUnavailable({})),
    }),
    Effect.annotateLogs({ operation }),
    Effect.interruptible
  )
