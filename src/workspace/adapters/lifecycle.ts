import {
  LifecycleCapability,
  type LifecycleJob,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from "agents/lifecycle"
import { Clock, Effect, Schema } from "effect"

import { nativeFailure } from "../../shared/interop"
import {
  armWorkspaceDiscovery,
  observeWorkspaceDiscovery,
  readWorkspaceDiscovery,
  readWorkspacePump,
  decideWorkspacePump,
  type WorkspacePump,
} from "../discovery.machine"
import { WorkspaceUnavailable } from "../files"
import type { PreparationClaim } from "../workspace"

const pumpId = "workspace-extraction:pump"
const discoveryId = "workspace-extraction:recovery"
const retry = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 }
type Dispatch = {
  job: LifecycleJob
  state: WorkspacePump
  wakeRequested: boolean
  ended: boolean
  inFlight: boolean
}
function pumpPayload(token: string): WorkspacePump {
  return {
    schemaVersion: 1,
    workflowVersion: 1,
    token,
    phase: "dispatch",
    claim: null,
    cleanupAt: 0,
    finalBatch: false,
  }
}
function readJob(job: LifecycleJob) {
  if (job.id === pumpId && job.fn === "pump") {
    // The former ExtractionRunner used no payload. Keep the same queue identity.
    return job.payload === undefined || job.payload === null
      ? pumpPayload(`legacy:${job.createdAt}:${job.time}`)
      : readWorkspacePump(job.payload)
  }
  if (job.id === discoveryId && job.fn === "recover")
    return readWorkspaceDiscovery(job.payload)
  throw new Error(`Unsupported Workspace job: ${job.id}/${job.fn}`)
}

/** Lifecycle owns the only alarm and its three transport attempts. Preparation
 * owns native scope joining, business attempts and persisted recovery deadlines. */
export class WorkspaceRunner<E> extends LifecycleCapability {
  private readonly dispatches = new Map<string, Dispatch>()
  private restoring?: Promise<void>
  private restored = false
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

  private current(id: string) {
    const job = this.lifecycle.jobs.get(id)
    if (job) readJob(job)
    return job
  }
  private owns(job: LifecycleJob) {
    const current = this.current(job.id)
    return !!current && readJob(current).token === readJob(job).token
  }
  private outcome(job: LifecycleJob, result: LifecycleJobOutcome) {
    const current = this.current(job.id)
    return current && readJob(current).token !== readJob(job).token
      ? { rescheduleAt: current.time }
      : result
  }
  private pushPump(time: number, payload = pumpPayload(crypto.randomUUID())) {
    return this.lifecycle.jobs.push({
      id: pumpId,
      fn: "pump",
      payload: { ...payload, token: crypto.randomUUID() },
      time,
      singleflight: true,
      recoveryLoop: true,
      hungTimeoutSeconds: 600,
      retry,
    })
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
  async armDiscovery(): Promise<number> {
    const now = Date.now()
    const deadline = now + 60_000
    const prior = this.current(discoveryId)
    await this.lifecycle.jobs.push({
      id: discoveryId,
      fn: "recover",
      payload: armWorkspaceDiscovery(
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
      await this.pushPump(Date.now())
      return
    }
    const payload = readJob(current)
    const dispatch = this.dispatches.get(payload.token)
    if (dispatch || ("phase" in payload && payload.phase !== "dispatch")) {
      if (dispatch) dispatch.wakeRequested = true
      // Reschedule/push clears SDK running state and would renew tryN's budget.
      await this.lifecycle.jobs.rearm()
      return
    }
    await this.lifecycle.jobs.reschedule(pumpId, Date.now())
  }
  async reconcile() {
    this.current(pumpId)
    this.current(discoveryId)
    await this.restore()
    if (!this.current(pumpId) && !this.current(discoveryId)) {
      const next = await this.host.run(this.host.nextWake())
      if (next !== undefined && !this.current(pumpId)) await this.pushPump(next)
    }
    await this.lifecycle.jobs.rearm()
  }
  private async finishCleanup(
    dispatch: Dispatch
  ): Promise<LifecycleJobOutcome> {
    const { job, state } = dispatch
    const deadline = await this.host.run(
      this.host.exhaust(state.claim ?? undefined, () => this.owns(job))
    )
    if (!this.owns(job)) return this.outcome(job, undefined)
    if (!state.claim && deadline !== undefined && !state.finalBatch) {
      // A failure before CLAIM can only expire pending rows at their deadline.
      dispatch.state = decideWorkspacePump(state, {
        type: "DEFER_CLEANUP",
        at: deadline,
      })
      await this.pushPump(deadline, dispatch.state)
      this.dispatches.delete(state.token)
      return { rescheduleAt: deadline }
    }
    // Exact exhaustion committed before any unrelated provider work is allowed.
    // A successful expiry-only final pass likewise leaves only newer admissions.
    const next = await this.host.run(this.host.nextWake())
    if (!this.owns(job)) return this.outcome(job, undefined)
    if (next !== undefined) await this.pushPump(next)
    dispatch.state = decideWorkspacePump(state, { type: "SAVED" })
    this.dispatches.delete(state.token)
    return this.outcome(job, undefined)
  }
  private async discover(job: LifecycleJob): Promise<LifecycleJobOutcome> {
    const now = await this.host.run(Clock.currentTimeMillis)
    await this.restore()
    const pending = (await this.host.run(this.host.nextWake())) !== undefined
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
  private async dispatch(
    job: LifecycleJob,
    dispatch: Dispatch
  ): Promise<LifecycleJobOutcome> {
    await this.restore()
    if (!this.owns(job)) {
      if (dispatch.state.phase === "dispatch" && !dispatch.state.claim)
        this.dispatches.delete(dispatch.state.token)
      return this.outcome(job, undefined)
    }
    if (dispatch.state.phase === "retired") return this.outcome(job, undefined)
    if (dispatch.state.phase === "cleanup") {
      if (dispatch.state.finalBatch && Date.now() < dispatch.state.cleanupAt)
        return this.outcome(job, { rescheduleAt: dispatch.state.cleanupAt })
      return await this.finishCleanup(dispatch)
    }
    const owner = dispatch
    const next = await this.host.step((claim) =>
      Effect.suspend(() => {
        owner.state = decideWorkspacePump(owner.state, {
          type: "CLAIMED",
          claim,
        })
        return this.owns(job)
          ? Effect.void
          : Effect.fail(new WorkspaceUnavailable({}))
      })
    )
    this.dispatches.delete(dispatch.state.token)
    return this.outcome(
      job,
      dispatch.wakeRequested
        ? { rescheduleAt: Math.min(next ?? Infinity, Date.now()) }
        : next === undefined
          ? undefined
          : { rescheduleAt: next }
    )
  }
  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    const payload = readJob(job)
    if (!this.owns(job)) return this.outcome(job, undefined)
    if (job.fn === "recover") return this.discover(job)
    const live = [...this.dispatches.values()].find(
      (entry) => !entry.ended && (entry.job !== job || entry.inFlight)
    )
    if (live)
      return this.outcome(job, {
        rescheduleAt: Math.max(Date.now() + 1000, live.state.cleanupAt),
      })
    let dispatch = this.dispatches.get(payload.token)
    if (!dispatch) {
      const orphan = [...this.dispatches.values()].find(
        (entry) => entry.ended && entry.state.phase === "cleanup"
      )
      if (orphan) this.dispatches.delete(orphan.state.token)
      dispatch = {
        job,
        state: orphan
          ? decideWorkspacePump(orphan.state, {
              type: "TRANSFER",
              token: payload.token,
            })
          : readWorkspacePump(payload),
        wakeRequested: false,
        ended: false,
        inFlight: false,
      }
      this.dispatches.set(payload.token, dispatch)
    } else if (dispatch.ended) {
      dispatch.job = job
      dispatch.ended = false
    }
    dispatch.inFlight = true
    try {
      const result = await this.dispatch(job, dispatch)
      dispatch.ended = true
      return result
    } catch (error) {
      // host.step only settles after the domain's actual native scope joins.
      dispatch.state = decideWorkspacePump(dispatch.state, {
        type: "FAILED",
        now: Date.now(),
      })
      throw error
    } finally {
      dispatch.inFlight = false
      this.host.notify?.()
    }
  }
  async onJobError(
    { job }: LifecycleJobContext,
    error: unknown
  ): Promise<LifecycleJobOutcome> {
    const payload = readJob(job)
    if (!this.owns(job)) {
      const previous = this.dispatches.get(payload.token)
      if (previous?.job === job && !previous.inFlight) previous.ended = true
      return this.outcome(job, undefined)
    }
    if (job.fn === "recover") {
      const command = observeWorkspaceDiscovery(job.payload, {
        now: Date.now(),
        pending: false,
      }).find((command) => command.type === "reschedule")
      return this.outcome(
        job,
        command ? { rescheduleAt: command.at } : undefined
      )
    }
    const live = [...this.dispatches.values()].find(
      (entry) => !entry.ended && (entry.job !== job || entry.inFlight)
    )
    if (live)
      return this.outcome(job, {
        rescheduleAt: Math.max(Date.now() + 1000, live.state.cleanupAt),
      })
    let dispatch = this.dispatches.get(payload.token)
    dispatch ??= {
      job,
      state: decideWorkspacePump(payload, { type: "FAILED", now: Date.now() }),
      wakeRequested: false,
      ended: false,
      inFlight: false,
    }
    this.dispatches.set(payload.token, dispatch)
    dispatch.inFlight = true
    try {
      return await this.exhaustBudget(dispatch, error)
    } finally {
      dispatch.inFlight = false
      dispatch.ended = true
    }
  }
  private async exhaustBudget(
    dispatch: Dispatch,
    error: unknown
  ): Promise<LifecycleJobOutcome> {
    const job = dispatch.job
    const next = decideWorkspacePump(dispatch.state, { type: "EXHAUSTED" })
    dispatch.state = next
    // Logging must not erase the retained recovery outcome if a runtime/log sink fails.
    try {
      await this.host.run(
        Effect.logError(
          "Workspace preparation job exhausted",
          { job: job.id, claim: next.claim, finalBatch: next.finalBatch },
          error
        )
      )
    } catch {
      /* Recovery below remains authoritative. */
    }
    this.host.notify?.()
    if (!this.owns(job)) return this.outcome(job, undefined)
    if (next.phase === "retired") {
      this.dispatches.delete(dispatch.state.token)
      // The final finite budget runs after the original recovery deadline.
      // Joined-token status expiry or actual cold restoration makes the row
      // actionable when storage recovers; no automatic provider replay here.
      return this.outcome(job, undefined)
    }
    try {
      await this.pushPump(next.cleanupAt, next)
      this.dispatches.delete(dispatch.state.token)
    } catch {
      // If the payload write itself failed, keep the exact warm receipt. The
      // existing SDK row/outcome still retains its wake. Availability is required
      // to persist a receipt across an isolate loss, as for all domain commits.
    }
    return this.outcome(job, { rescheduleAt: next.cleanupAt })
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
