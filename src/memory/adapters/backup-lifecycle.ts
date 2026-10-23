import {
  LifecycleCapability,
  type LifecycleJob,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from "agents/lifecycle"
import { Cause, Effect, Exit, Schema } from "effect"

import {
  armBackupDiscovery,
  observeBackupDiscovery,
  readBackupDiscovery,
  decideBackupController,
  initialBackupController,
  readBackupController,
  type BackupController,
  type BackupSchedulerRecovery,
} from "../backup-discovery.machine"
import {
  decideBackupDispatch,
  initialBackupDispatch,
  type BackupDispatch,
} from "../backup-dispatch.machine"
import { BackupClaim, type BackupRecoveryLease } from "../backup.machine"
import type { MemoryStorageError } from "../domain"

const id = "memory-backups:pump"
const discoveryId = "memory-backups:discovery"
const controllerKey = "memory-backups:failure"
export class BackupRecoveryChanged extends Error {}
const Payload = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  token: Schema.String,
  phase: Schema.Literals(["work", "cleanup"]),
  claim: Schema.NullOr(BackupClaim),
  discoveryDeadline: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
type Payload = typeof Payload.Type
const readPayload = Schema.decodeUnknownSync(Payload)
const payload = (job: LifecycleJob): Payload => {
  if (job.id !== id || job.fn !== "pump")
    throw new Error(`Unsupported backup job: ${job.id}/${job.fn}`)
  return job.payload === undefined || job.payload === null
    ? {
        schemaVersion: 1,
        workflowVersion: 1,
        token: `legacy:${job.createdAt}`,
        phase: "work",
        claim: null,
        discoveryDeadline: 0,
      }
    : readPayload(job.payload)
}
const readJob = (job: LifecycleJob) =>
  job.id === discoveryId && job.fn === "discover"
    ? readBackupDiscovery(job.payload)
    : payload(job)
type Owned = {
  state: BackupDispatch
  claim?: BackupClaim
  pending?: Promise<void>
  controller?: AbortController
}

/** Lifecycle retains the exact legacy queue identity and alarm. The dispatch
 * machine keeps slow native work outside alarm dispatch, without releasing its
 * actual Effect/native ownership. Domain storage owns business retry budgets. */
export class BackupRunner<E, R = never> extends LifecycleCapability {
  private readonly owned = new Map<string, Owned>()
  private restoring?: Promise<void>
  private stopped = false
  private gate: Promise<unknown> = Promise.resolve()
  private unpersisted?: BackupController
  private readonly operations = new Set<Promise<unknown>>()
  private readonly cleanup = new Set<Promise<void>>()
  constructor(
    readonly host: {
      run: <A>(
        work: Effect.Effect<A, E, R>,
        options?: { signal?: AbortSignal }
      ) => Promise<A>
      step: (
        onClaim: (claim: BackupClaim) => Effect.Effect<void, MemoryStorageError>
      ) => Effect.Effect<number | undefined, E, R>
      restore: () => Effect.Effect<void, E, R>
      exhaust: (
        claim: BackupClaim | undefined,
        current: () => boolean
      ) => Effect.Effect<void, E, R>
      retain: (work: Promise<void>) => void
      notify?: () => void
    }
  ) {
    super("memory-backups")
  }
  private run<A>(
    work: Effect.Effect<A, E, R>,
    options?: { signal?: AbortSignal }
  ) {
    // Carry the complete Exit across a host runner that otherwise selects one
    // error. The observed exit also survives interruption of the outer runner.
    let observed: Exit.Exit<A, E> | undefined
    const captured = work.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          observed = exit
        })
      )
    )
    return this.host.run(Effect.exit(captured), options).then(
      (exit) => {
        if (Exit.isFailure(exit)) throw exit.cause
        return exit.value
      },
      (error: unknown) => {
        if (observed && Exit.isFailure(observed)) throw observed.cause
        throw error
      }
    )
  }
  private track<A>(work: Promise<A>): Promise<A> {
    this.operations.add(work)
    void work.then(
      () => this.operations.delete(work),
      () => this.operations.delete(work)
    )
    return work
  }
  private retainedClaim() {
    const job = this.current()
    if (job) {
      const value = payload(job)
      if (value.claim) return value.claim
      const owner = this.owned.get(value.token)
      if (owner?.claim) return owner.claim
    }
    return [...this.owned.values()]
      .reverse()
      .find((owner) => owner.state.phase === "failed" && owner.claim)?.claim
  }
  private async claimPublication(claim: BackupClaim) {
    await this.serial(async () => {
      const state = await this.control()
      if (state.phase !== "exhausted") return
      const next = decideBackupController(state, { type: "ATTACH", claim })
      this.unpersisted = next
      await this.lifecycle.storage.put(controllerKey, next)
      this.unpersisted = undefined
      throw new Error("Backup scheduling exhausted before publication")
    })
  }
  private async settledClaim(claim: BackupClaim | null) {
    if (!claim) return
    await this.serial(async () => {
      const state = await this.control()
      const next = decideBackupController(state, {
        type: "SETTLED",
        attemptId: claim.attemptId,
      })
      await this.lifecycle.storage.put(controllerKey, next)
      for (const [token, owner] of this.owned)
        if (!owner.pending && owner.claim?.attemptId === claim.attemptId)
          this.owned.delete(token)
    })
  }
  private serial<A>(body: () => Promise<A>): Promise<A> {
    const work = this.gate.then(body, body)
    this.gate = work.then(
      () => undefined,
      () => undefined
    )
    return work
  }
  private async control() {
    if (this.unpersisted) return this.unpersisted
    const raw = await this.lifecycle.storage.get(controllerKey)
    return raw === undefined
      ? initialBackupController()
      : readBackupController(raw)
  }
  private live() {
    return (
      this.cleanup.size > 0 ||
      [...this.owned.values()].some((owner) => owner.pending !== undefined)
    )
  }
  private async settle(claim: BackupClaim | undefined, job: LifecycleJob) {
    const work = this.run(this.host.exhaust(claim, () => this.owns(job)))
    this.cleanup.add(work)
    try {
      await work
    } finally {
      this.cleanup.delete(work)
    }
  }
  recovery(): Promise<BackupSchedulerRecovery | undefined> {
    return this.serial(async () => {
      const state = await this.control()
      return state.phase === "exhausted" ? state.recovery! : undefined
    })
  }
  private async exhaustScheduler(job: LifecycleJob, claim?: BackupClaim) {
    await this.serial(async () => {
      // An unavailable read may hide the sole durable cleanup receipt. Only a
      // confirmed absent record may initialize control; never overwrite unknown.
      const state = await this.control()
      if (!this.owns(job) || state.phase === "exhausted") return
      const next = decideBackupController(state, {
        type: "EXHAUST",
        token: readJob(job).token,
        claim: claim ?? this.retainedClaim() ?? state.claim ?? null,
        recovery: {
          epoch: crypto.randomUUID(),
          failedAt: Date.now(),
          message:
            "Backup scheduling could not persist or discover its work. Retry backup recovery when storage is available.",
        },
      })
      this.unpersisted = next
      try {
        await this.lifecycle.storage.put(controllerKey, next)
        this.unpersisted = undefined
      } finally {
        this.host.notify?.()
      }
    })
  }
  private current(jobId = id) {
    const job = this.lifecycle.jobs.get(jobId)
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
  private push(value: Payload, time: number) {
    return this.lifecycle.jobs.push({
      id,
      fn: "pump",
      payload: value,
      time,
      singleflight: true,
      recoveryLoop: true,
      hungTimeoutSeconds: 600,
      retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
    })
  }
  async reconcile() {
    if (this.stopped) return
    this.current()
    this.current(discoveryId)
    this.restoring ??= this.run(this.host.restore()).catch((error: unknown) => {
      this.restoring = undefined
      throw error
    })
    await this.restoring
    if (!this.stopped) await this.lifecycle.jobs.rearm()
  }
  private async arm(): Promise<BackupRecoveryLease> {
    if (this.stopped) throw new Error("Backup runner is stopped")
    const now = Date.now(),
      prior = this.current(discoveryId)
    const value = armBackupDiscovery(
      prior?.payload,
      now + 60_000,
      crypto.randomUUID()
    )
    await this.lifecycle.jobs.push({
      id: discoveryId,
      fn: "discover",
      time: Math.min(now, prior?.time ?? Infinity),
      payload: value,
      singleflight: true,
      recoveryLoop: true,
      retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
    })
    return {
      deadline: value.deadline,
      current: () => {
        const current = this.current(discoveryId)
        if (!current) return false
        const stored = readBackupDiscovery(current.payload)
        return (
          stored.token === value.token && stored.deadline === value.deadline
        )
      },
    }
  }
  armDiscovery(): Promise<BackupRecoveryLease> {
    return this.serial(async () => {
      if ((await this.control()).phase === "exhausted")
        throw new BackupRecoveryChanged(
          "Retry backup scheduling recovery before adding memory."
        )
      return this.arm()
    })
  }
  armSchedulerRecovery(epoch: string): Promise<BackupRecoveryLease> {
    return this.serial(async () => {
      const state = await this.control()
      if (
        this.live() ||
        state.phase !== "exhausted" ||
        state.recovery?.epoch !== epoch
      )
        throw new BackupRecoveryChanged(
          "Backup recovery changed or is still running. Refresh its status."
        )
      return this.arm()
    })
  }
  retrySchedulerRecovery(
    epoch: string,
    lease: BackupRecoveryLease
  ): Promise<boolean> {
    return this.serial(async () => {
      const state = await this.control()
      if (
        this.live() ||
        state.phase !== "exhausted" ||
        state.recovery?.epoch !== epoch ||
        !Number.isFinite(lease.deadline) ||
        lease.deadline <= Date.now() ||
        !lease.current()
      )
        return false
      if (this.stopped) return false
      const next = decideBackupController(
        { ...state, claim: state.claim ?? this.retainedClaim() ?? null },
        { type: "RECOVER", epoch }
      )
      await this.lifecycle.storage.put(controllerKey, next)
      this.unpersisted = undefined
      return true
    }).then(async (recovered) => {
      if (recovered) await this.wake()
      return recovered
    })
  }
  private unsettledReceipt() {
    const job = this.current()
    return (
      (job !== undefined && payload(job).phase === "cleanup") ||
      [...this.owned.values()].some(
        (owner) => owner.state.phase === "failed" && owner.claim !== undefined
      )
    )
  }
  armRecovery(): Promise<BackupRecoveryLease> {
    return this.serial(async () => {
      const state = await this.control()
      if (
        this.live() ||
        this.unsettledReceipt() ||
        state.phase === "exhausted" ||
        state.claim
      )
        throw new BackupRecoveryChanged(
          "Backup recovery changed or is still running. Refresh its status."
        )
      return this.armDomainRecovery()
    })
  }
  private async armDomainRecovery(): Promise<BackupRecoveryLease> {
    if (this.stopped) throw new Error("Backup runner is stopped")
    const token = crypto.randomUUID(),
      deadline = Date.now() + 60_000
    await this.push(
      {
        schemaVersion: 1,
        workflowVersion: 1,
        token,
        phase: "work",
        claim: null,
        discoveryDeadline: deadline,
      },
      Date.now()
    )
    return {
      deadline,
      current: () => {
        const job = this.current()
        if (!job) return false
        const stored = payload(job)
        return (
          stored.token === token &&
          stored.phase === "work" &&
          stored.discoveryDeadline === deadline
        )
      },
    }
  }
  wake() {
    return this.serial(() => this.wakeNow())
  }
  private async wakeNow() {
    if (this.stopped) return
    const control = await this.control()
    if (this.stopped || control.phase === "exhausted") return
    const job = this.current()
    if (control.claim) {
      if (
        !job ||
        payload(job).phase !== "cleanup" ||
        payload(job).claim?.attemptId !== control.claim.attemptId
      )
        await this.push(
          {
            schemaVersion: 1,
            workflowVersion: 1,
            token: crypto.randomUUID(),
            phase: "cleanup",
            claim: control.claim,
            discoveryDeadline: 0,
          },
          Date.now()
        )
      else await this.lifecycle.jobs.rearm()
      return
    }
    if (!job || readJob(job).token === control.retiredToken) {
      await this.push(
        {
          schemaVersion: 1,
          workflowVersion: 1,
          token: crypto.randomUUID(),
          phase: "work",
          claim: null,
          discoveryDeadline: 0,
        },
        Date.now()
      )
      return
    }
    const value = payload(job),
      owner = this.owned.get(value.token)
    if (owner)
      owner.state = decideBackupDispatch(owner.state, { type: "WAKE" }).state
    if ((owner && owner.state.phase !== "idle") || value.phase === "cleanup")
      await this.lifecycle.jobs.rearm()
    else await this.lifecycle.jobs.reschedule(id, Date.now())
  }
  private start(job: LifecycleJob, owner: Owned) {
    const controller = new AbortController()
    owner.controller = controller
    const work = this.run(
      this.host.step((claim) =>
        Effect.sync(() => {
          owner.claim = claim
        }).pipe(
          Effect.andThen(Effect.promise(() => this.claimPublication(claim)))
        )
      ),
      { signal: controller.signal }
    )
      .then(
        (next) => {
          owner.state = decideBackupDispatch(owner.state, {
            type: "SUCCEEDED",
            next: next ?? null,
          }).state
        },
        (error: unknown) => {
          owner.state = decideBackupDispatch(owner.state, {
            type: "FAILED",
            error,
          }).state
        }
      )
      .then(async () => {
        // The native producer has joined before the queued wake is advanced.
        if (!this.stopped && this.owns(job))
          await this.lifecycle.jobs.reschedule(id, Date.now())
      })
      .catch((error: unknown) => {
        // Keep a scheduling failure observable on the retained heartbeat. Never
        // renew a domain budget or drop a provider/cleanup Cause here.
        const prior =
          owner.state.phase === "failed" ? owner.state.error : undefined
        const errors = prior === undefined ? [error] : [prior, error]
        owner.state = decideBackupDispatch(owner.state, {
          type: "QUEUE_FAILED",
          error: Cause.fromReasons(
            errors.flatMap(
              (value) =>
                (Cause.isCause(value) ? value : Cause.die(value)).reasons
            )
          ),
        }).state
      })
      .finally(() => {
        owner.pending = undefined
        owner.controller = undefined
        if (!this.owns(job)) this.owned.delete(payload(job).token)
      })
    owner.pending = work
    this.lifecycle.trackAlarmWork(work)
    this.host.retain(work)
  }
  private async discover(job: LifecycleJob): Promise<LifecycleJobOutcome> {
    let result: LifecycleJobOutcome
    for (const command of observeBackupDiscovery(job.payload, Date.now())) {
      if (command.type === "wake") await this.wake()
      else result = { rescheduleAt: command.at }
    }
    return this.outcome(job, result)
  }
  private blocked(control: BackupController, job: LifecycleJob) {
    const token = readJob(job).token
    if (control.phase !== "exhausted" && control.retiredToken !== token)
      return undefined
    if (this.owned.get(token)?.pending)
      return { outcome: { rescheduleAt: Date.now() + 30_000 } }
    return job.fn !== "discover" || control.retiredToken === token
      ? { outcome: undefined }
      : undefined
  }
  onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    return this.track(this.dispatch(context))
  }
  private async dispatch({
    job,
  }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (this.stopped) return
    const control = await this.serial(() => this.control())
    if (this.stopped || !this.owns(job)) return this.outcome(job, undefined)
    const blocked = this.blocked(control, job)
    if (blocked) return this.outcome(job, blocked.outcome)
    if (job.fn === "discover") return this.discover(job)
    const value = payload(job)
    await this.reconcile()
    if (this.stopped || !this.owns(job)) return this.outcome(job, undefined)
    if (value.phase === "cleanup") {
      await this.settle(value.claim ?? undefined, job)
      await this.settledClaim(value.claim)
      return this.outcome(job, undefined)
    }
    let owner = this.owned.get(value.token)
    if (!owner) {
      owner = { state: initialBackupDispatch() }
      this.owned.set(value.token, owner)
    }
    const decision = decideBackupDispatch(owner.state, {
      type: "POLL",
      now: Date.now(),
      retainUntil: value.discoveryDeadline,
    })
    owner.state = decision.state
    let result: LifecycleJobOutcome
    for (const command of decision.commands) {
      if (command.type === "start") this.start(job, owner)
      else if (command.type === "raise") throw command.error
      else result = { rescheduleAt: command.at }
    }
    if (result === undefined && owner.state.phase === "idle")
      this.owned.delete(value.token)
    return this.outcome(job, result)
  }
  onJobError(
    context: LifecycleJobContext,
    error: unknown
  ): Promise<LifecycleJobOutcome> {
    return this.track(this.failed(context, error))
  }
  private async failed(
    { job }: LifecycleJobContext,
    error: unknown
  ): Promise<LifecycleJobOutcome> {
    if (this.stopped) return
    if (!this.owns(job)) return this.outcome(job, undefined)
    if (job.fn === "discover") {
      await this.exhaustScheduler(job)
      await this.run(
        Effect.logError("Memory backup discovery exhausted", error)
      )
      return this.outcome(job, undefined)
    }
    const value = payload(job)
    const owner = this.owned.get(value.token)
    if (owner?.pending) await owner.pending
    try {
      await this.run(Effect.logError("Memory backup job exhausted", error))
    } catch {
      /* Recovery remains authoritative. */
    }
    this.owned.delete(value.token)
    const claim = owner?.claim ?? value.claim ?? undefined
    if (value.phase === "cleanup" || !claim) {
      await this.exhaustScheduler(job, claim)
      return this.outcome(job, undefined)
    }
    try {
      await this.settle(claim, job)
      return this.outcome(job, undefined)
    } catch {
      // One finite storage-only budget may publish the already joined terminal
      // receipt. It can never call the backup provider again.
      if (!this.owns(job)) return this.outcome(job, undefined)
      const at = Date.now() + 1000
      await this.push(
        {
          schemaVersion: 1,
          workflowVersion: 1,
          token: crypto.randomUUID(),
          phase: "cleanup",
          claim: claim ?? null,
          discoveryDeadline: 0,
        },
        at
      )
      return { rescheduleAt: at }
    }
  }
  async dispose() {
    this.stopped = true
    const owners = [...this.owned.values()]
    for (const owner of owners) owner.controller?.abort()
    const settled = await Promise.allSettled([
      ...this.operations,
      ...owners.map((owner) => owner.pending),
      this.restoring,
      this.gate,
    ])
    const operationCauses = settled.flatMap((outcome) =>
      outcome.status === "rejected"
        ? [
            Cause.isCause(outcome.reason)
              ? outcome.reason
              : Cause.die(outcome.reason),
          ]
        : []
    )
    const causes = [
      ...operationCauses,
      ...owners.flatMap((owner) => {
        if (owner.state.phase !== "failed") return []
        const error = owner.state.error
        const cause = Cause.isCause(error) ? error : Cause.die(error)
        // The requested cancellation is expected; failed native cleanup is not.
        return Cause.hasDies(cause) || Cause.hasFails(cause) ? [cause] : []
      }),
    ]
    if (causes.length)
      throw Cause.fromReasons(causes.flatMap((cause) => cause.reasons))
  }
}
