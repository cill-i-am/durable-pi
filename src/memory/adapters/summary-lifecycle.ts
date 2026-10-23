import {
  LifecycleCapability,
  type LifecycleJob,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from "agents/lifecycle"
import { Cause, Effect, Exit, Schema } from "effect"

import {
  armSummaryDiscovery,
  decideSummaryController,
  decideSummaryDispatch,
  initialSummaryController,
  initialSummaryDispatch,
  observeSummaryDiscovery,
  readSummaryController,
  readSummaryDiscovery,
  type SummaryController,
  type SummaryDispatch,
  type SummaryRecovery,
} from "../summary-discovery.machine"

export class SummaryRecoveryChanged extends Error {}

const pumpId = "memory-compactor:pump"
const discoveryId = "memory-compactor:discovery"
const controllerKey = "memory-compactor:failure"
const retry = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 }
const Pump = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  token: Schema.String.check(Schema.isNonEmpty()),
})
function readJob(job: LifecycleJob) {
  if (job.id === discoveryId && job.fn === "discover")
    return readSummaryDiscovery(job.payload)
  if (job.id === pumpId && job.fn === "pump")
    return job.payload === undefined || job.payload === null
      ? { token: `legacy:${job.createdAt}` }
      : Schema.decodeUnknownSync(Pump)(job.payload)
  throw new Error(`Unsupported summary job: ${job.id}/${job.fn}`)
}
type Owned = {
  state: SummaryDispatch
  pending?: Promise<void>
  controller?: AbortController
}

/** Domain claims own model authority and all joined settlement receipts. This
 * capability owns only retained discovery, alarm fairness and a bounded storage
 * dispatch budget. A controller failure never changes an unrelated summary. */
export class SummaryRunner<E, R = never> extends LifecycleCapability {
  private readonly owned = new Map<string, Owned>()
  private gate: Promise<unknown> = Promise.resolve()
  private unpersisted?: SummaryController
  private observedControl?: SummaryController
  private restoring?: Promise<void>
  private stopped = false
  constructor(
    readonly host: {
      run: <A>(
        work: Effect.Effect<A, E, R>,
        options?: { signal?: AbortSignal }
      ) => Promise<A>
      step: () => Effect.Effect<number | undefined, E, R>
      settle: () => Effect.Effect<void, E, R>
      nextWake: () => Effect.Effect<number | undefined, E, R>
      restore: () => Effect.Effect<void, E, R>
      retain: (work: Promise<void>) => void
      notify?: () => void
    }
  ) {
    super("memory-compactor")
  }

  private run<A>(
    work: Effect.Effect<A, E, R>,
    options?: { signal?: AbortSignal }
  ) {
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
  private serial<A>(body: () => Promise<A>): Promise<A> {
    const work = this.gate.then(body, body)
    this.gate = work.then(
      () => undefined,
      () => undefined
    )
    return work
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
  private async control() {
    if (this.unpersisted) return this.unpersisted
    const raw = await this.lifecycle.storage.get(controllerKey)
    const control =
      raw === undefined
        ? initialSummaryController()
        : readSummaryController(raw)
    this.observedControl = control
    return control
  }
  private permitted(job: LifecycleJob, control: SummaryController) {
    return (
      !this.stopped &&
      this.owns(job) &&
      control.phase === "available" &&
      control.retiredToken !== readJob(job).token
    )
  }
  private pushPump(time: number, token: string = crypto.randomUUID()) {
    return this.lifecycle.jobs.push({
      id: pumpId,
      fn: "pump",
      payload: {
        schemaVersion: 1,
        workflowVersion: 1,
        token,
      },
      time,
      singleflight: true,
      recoveryLoop: true,
      hungTimeoutSeconds: 600,
      retry,
    })
  }
  private async arm(recoveryEpoch: string | null) {
    if (this.stopped) throw new Error("Summary runner is stopped")
    const now = Date.now(),
      prior = this.current(discoveryId)
    const payload = armSummaryDiscovery(
      prior?.payload,
      now + 60_000,
      crypto.randomUUID(),
      recoveryEpoch
    )
    await this.lifecycle.jobs.push({
      id: discoveryId,
      fn: "discover",
      payload,
      time: Math.min(now, prior?.time ?? Infinity),
      singleflight: true,
      recoveryLoop: true,
      retry,
    })
    return payload.armedUntil
  }
  armDiscovery(): Promise<number> {
    return this.serial(async () => {
      if ((await this.control()).phase === "exhausted")
        throw new SummaryRecoveryChanged(
          "Retry compaction recovery before adding more summary work."
        )
      return this.arm(null)
    })
  }
  discoveryCurrent(deadline: number): boolean {
    const job = this.current(discoveryId)
    const lease = job && readSummaryDiscovery(job.payload)
    return (
      !this.stopped &&
      !this.unpersisted &&
      this.observedControl?.phase !== "exhausted" &&
      !!lease &&
      lease.recoveryEpoch === null &&
      Number.isFinite(deadline) &&
      lease.armedUntil >= deadline
    )
  }
  recovery(): Promise<SummaryRecovery | undefined> {
    return this.serial(async () => {
      const control = await this.control()
      return control.phase === "exhausted" ? control.recovery! : undefined
    })
  }
  armRecovery(epoch: string): Promise<number> {
    return this.serial(async () => {
      const control = await this.control()
      if (control.phase !== "exhausted" || control.recovery?.epoch !== epoch)
        throw new SummaryRecoveryChanged(
          "Summary recovery changed. Refresh its status."
        )
      return this.arm(epoch)
    })
  }
  retryRecovery(epoch: string, deadline: number): Promise<boolean> {
    return this.serial(async () => {
      const control = await this.control()
      if (control.phase === "available")
        return control.recovery?.epoch === epoch
      const discovery = this.current(discoveryId)
      const lease = discovery && readSummaryDiscovery(discovery.payload)
      if (
        control.recovery?.epoch !== epoch ||
        !Number.isFinite(deadline) ||
        deadline <= Date.now() ||
        !lease ||
        lease.recoveryEpoch !== epoch ||
        lease.armedUntil < deadline
      )
        return false
      // The actual retained lease covers failure after the controller commit but
      // before the following doorbell. The spent token remains fenced forever.
      const next = decideSummaryController(control, { type: "RECOVER", epoch })
      await this.lifecycle.storage.put(controllerKey, next)
      this.observedControl = next
      this.unpersisted = undefined
      const retained = [...this.owned.entries()].find(
        ([, owner]) => owner.state.phase !== "idle"
      )
      if (retained?.[1].pending) {
        // Discovery can fail while a native producer is still alive. Recovery
        // repairs scheduling, never replaces that producer or its eight slots.
        const current = this.current(pumpId)
        if (!current || readJob(current).token !== retained[0])
          await this.pushPump(Date.now(), retained[0])
        else await this.lifecycle.jobs.rearm()
      } else {
        const fresh = await this.pushPump(Date.now())
        if (retained) {
          this.owned.delete(retained[0])
          this.owned.set(readJob(fresh).token, retained[1])
        }
      }
      return true
    })
  }
  async wake() {
    await this.serial(async () => {
      const control = await this.control()
      if (this.stopped || control.phase === "exhausted") return
      const current = this.current(pumpId)
      if (!current || readJob(current).token === control.retiredToken) {
        await this.pushPump(Date.now())
        return
      }
      const owner = this.owned.get(readJob(current).token)
      if (owner && owner.state.phase !== "idle") {
        owner.state = decideSummaryDispatch(owner.state, { type: "WAKE" }).state
        // Reschedule/push clears SDK running and would renew a failed dispatch.
        await this.lifecycle.jobs.rearm()
      } else await this.lifecycle.jobs.reschedule(pumpId, Date.now())
    })
  }
  /** Only the actual Durable Object onStart invokes cold restoration. Creating
   * another facade, ordinary status and reconcile never release a live claim. */
  async restore() {
    if (this.stopped) return
    this.restoring ??= this.run(this.host.restore()).catch((error: unknown) => {
      this.restoring = undefined
      throw error
    })
    await this.restoring
    if (!this.stopped) await this.reconcile()
  }
  async reconcile() {
    this.current(pumpId)
    this.current(discoveryId)
    const control = await this.serial(() => this.control())
    if (this.stopped) return
    if (
      control.phase === "available" &&
      !this.current(pumpId) &&
      !this.current(discoveryId)
    ) {
      const next = await this.run(this.host.nextWake())
      if (next !== undefined) await this.wake()
    }
    if (!this.stopped) await this.lifecycle.jobs.rearm()
  }
  private start(job: LifecycleJob, owner: Owned) {
    const controller = new AbortController()
    owner.controller = controller
    const work = this.run(Effect.suspend(this.host.step), {
      signal: controller.signal,
    })
      .then(
        (next) => {
          owner.state = decideSummaryDispatch(owner.state, {
            type: "SUCCEEDED",
            next: next ?? null,
          }).state
        },
        (error: unknown) => {
          owner.state = decideSummaryDispatch(owner.state, {
            type: "FAILED",
            error,
          }).state
        }
      )
      .then(async () => {
        // step's promise settles only after its Effect actor/native scope joins.
        if (!this.stopped && this.owns(job))
          await this.lifecycle.jobs.reschedule(job.id, Date.now())
      })
      .catch((error: unknown) => {
        const prior =
          owner.state.phase === "failed" ? owner.state.error : undefined
        const errors = prior === undefined ? [error] : [prior, error]
        owner.state = decideSummaryDispatch(owner.state, {
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
      })
    owner.pending = work
    this.lifecycle.trackAlarmWork(work)
    this.host.retain(work)
  }
  private settle(job: LifecycleJob, owner: Owned) {
    // Settlement includes storage publication and idempotent completion handoffs.
    // Join it before closing their runtime; interruption must not detach the
    // already-started handoff or permit a concurrent cleanup callback.
    const work = (async (): Promise<LifecycleJobOutcome> => {
      await this.run(Effect.suspend(this.host.settle))
      if (this.stopped || !this.owns(job)) return undefined
      const next = await this.run(Effect.suspend(this.host.nextWake))
      if (this.stopped || !this.owns(job)) return undefined
      owner.state = decideSummaryDispatch(owner.state, {
        type: "SUCCEEDED",
        next: next ?? null,
      }).state
      const settled = decideSummaryDispatch(owner.state, {
        type: "POLL",
        now: Date.now(),
      })
      owner.state = settled.state
      const wake = settled.commands.find((value) => value.type === "schedule")
      return wake ? { rescheduleAt: wake.at } : undefined
    })().catch((error: unknown) => {
      owner.state = decideSummaryDispatch(owner.state, {
        type: "SETTLE_FAILED",
        error: Cause.fromReasons(
          [owner.state.error, error].flatMap(
            (value) => (Cause.isCause(value) ? value : Cause.die(value)).reasons
          )
        ),
      }).state
      throw error
    })
    const pending = work
      .then(
        () => undefined,
        () => undefined
      )
      .finally(() => {
        owner.pending = undefined
      })
    owner.pending = pending
    this.lifecycle.trackAlarmWork(pending)
    this.host.retain(pending)
    return work
  }
  private async discover(job: LifecycleJob, control: SummaryController) {
    const now = Date.now()
    const pending =
      control.phase === "available" &&
      (await this.run(this.host.nextWake())) !== undefined
    if (this.stopped || !this.owns(job)) return this.outcome(job, undefined)
    let result: LifecycleJobOutcome
    for (const command of observeSummaryDiscovery(job.payload, now, pending)) {
      if (command.type === "wake") await this.wake()
      else result = { rescheduleAt: command.at }
    }
    return this.outcome(job, result)
  }
  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    const control = await this.serial(() => this.control())
    if (
      this.stopped ||
      !this.owns(job) ||
      control.retiredToken === readJob(job).token
    )
      return this.outcome(job, undefined)
    if (job.fn === "discover") return this.discover(job, control)
    if (control.phase === "exhausted") {
      const live = this.owned.get(readJob(job).token)
      return this.outcome(
        job,
        live?.pending ? { rescheduleAt: Date.now() + 30_000 } : undefined
      )
    }
    const token = readJob(job).token
    // A stale/replacement queue row cannot start a second warm native pass.
    if (
      [...this.owned.entries()].some(
        ([key, owner]) => key !== token && !!owner.pending
      )
    )
      return this.outcome(job, { rescheduleAt: Date.now() + 30_000 })
    let owner = this.owned.get(token)
    if (!owner) {
      owner = { state: initialSummaryDispatch() }
      this.owned.set(token, owner)
    }
    if (owner.pending)
      return this.outcome(job, { rescheduleAt: Date.now() + 30_000 })
    const decision = decideSummaryDispatch(owner.state, {
      type: "POLL",
      now: Date.now(),
    })
    owner.state = decision.state
    let result: LifecycleJobOutcome
    for (const command of decision.commands) {
      if (command.type === "start") this.start(job, owner)
      else if (command.type === "raise") throw command.error
      else if (command.type === "schedule")
        result = { rescheduleAt: command.at }
      else {
        // All claims in this pass have joined. This is receipt persistence only,
        // including up to eight concurrent claims, never another model request.
        result = await this.settle(job, owner)
      }
    }
    if (owner.state.phase === "idle") this.owned.delete(token)
    return this.outcome(job, result)
  }
  async onJobError(
    { job }: LifecycleJobContext,
    error: unknown
  ): Promise<LifecycleJobOutcome> {
    const owner = this.owned.get(readJob(job).token)
    if (owner?.pending) await owner.pending
    if (this.stopped) return this.outcome(job, undefined)
    await this.serial(async () => {
      // An unavailable read cannot establish absence. In particular a cold
      // callback must not replace a saved exact recovery epoch/retired token.
      const control = await this.control()
      if (!this.permitted(job, control)) return
      const next = decideSummaryController(control, {
        type: "EXHAUST",
        token: readJob(job).token,
        recovery: {
          epoch: crypto.randomUUID(),
          failedAt: Date.now(),
          message:
            "Memory compaction could not persist or discover its work. Retry compaction recovery after storage is available. Paused summaries still require their own retry.",
        },
      })
      // Keep a local spent marker even if this final write fails. The SDK swallows
      // onJobError failures and deletes the queue row; warm wakes must not renew it.
      this.unpersisted = next
      try {
        await this.lifecycle.storage.put(controllerKey, next)
        this.observedControl = next
        this.unpersisted = undefined
      } finally {
        this.host.notify?.()
      }
    })
    if (this.stopped) return this.outcome(job, undefined)
    this.owned.delete(readJob(job).token)
    await this.run(
      Effect.logError("Memory compaction scheduler exhausted", error)
    )
    return this.outcome(job, undefined)
  }
  async dispose() {
    this.stopped = true
    const owners = [...this.owned.values()]
    for (const owner of owners) owner.controller?.abort()
    await Promise.all(owners.map((owner) => owner.pending))
    const errors = owners
      .filter(
        (owner) =>
          owner.state.phase === "failed" || owner.state.phase === "cleanup"
      )
      .map((owner) => owner.state.error)
    if (errors.length)
      throw Cause.fromReasons(
        errors.flatMap(
          (error) => (Cause.isCause(error) ? error : Cause.die(error)).reasons
        )
      )
  }
}
