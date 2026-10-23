import {
  LifecycleCapability,
  type LifecycleJob,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from "agents/lifecycle"
import { Clock, Effect, Exit, Schema } from "effect"

import { nativeFailure } from "../../shared/interop"
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

type Dispatch = {
  job: LifecycleJob
  receipt?: CommunicationControlAttempt
  wakeRequested: boolean
  discoveryToken: string | null
}
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
  private readonly dispatches = new Map<string, Dispatch>()
  private restoring?: Promise<void>
  private restored = false
  private completedFailure?: { job: LifecycleJob; recovery: MailboxRecovery }

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

  private current(id: string) {
    const job = this.lifecycle.jobs.get(id)
    if (job) readJob(job)
    return job
  }
  private owns(job: LifecycleJob) {
    const latest = this.current(job.id)
    return !!latest && readJob(latest).token === readJob(job).token
  }
  private outcome(job: LifecycleJob, outcome: LifecycleJobOutcome) {
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
  async armDiscovery(recoveryEpoch?: string): Promise<number> {
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
    const completed = this.completedFailure
    if (!completed) return
    await this.lifecycle.storage.transaction(async (storage) => {
      const prior = readMailboxRecoveryState(await storage.get(recoveryKey))
      // A joined failed epoch can be retried after its SDK row was removed,
      // but cannot replace a newer pump or a newer durable failure summary.
      const current = this.current(completed.job.id)
      if (
        (current && !this.owns(completed.job)) ||
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
    if (this.completedFailure === completed) this.completedFailure = undefined
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
  async recovery(): Promise<MailboxRecovery | null> {
    return (await this.recoveryState()).recovery
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
  async retryRecovery(epoch: string, deadline: number): Promise<void> {
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
  async wake() {
    const state = await this.recoveryState()
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
    const dispatch = this.dispatches.get(readJob(current).token)
    if (dispatch) {
      // SDK push/reschedule clears its running marker. During tryN (including
      // gaps between failures) rearm only, so a doorbell cannot renew the budget.
      dispatch.wakeRequested = true
      await this.lifecycle.jobs.rearm()
      return
    }
    await this.lifecycle.jobs.reschedule(pumpId, Date.now())
  }
  async reconcile() {
    this.current(pumpId)
    this.current(discoveryId)
    if (!this.restored) {
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
    await this.reconcileQueue()
  }
  async reconcileQueue() {
    const recovery = await this.recovery()
    const allowed = this.mayWake(recovery)
    const pump = this.current(pumpId)
    const discovery = this.current(discoveryId)
    if (allowed && !pump && !discovery) {
      const next = await this.host.run(this.host.nextWake())
      // No awaited work lies between this second absence check and push.
      if (next !== undefined && !this.current(pumpId)) await this.pushPump(next)
    }
    await this.lifecycle.jobs.rearm()
  }
  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    const owner = readJob(job)
    if (!this.owns(job)) return this.outcome(job, undefined)
    if (job.fn === "recover") {
      if (!this.mayWake(await this.recovery())) {
        const lease = readCommunicationDiscovery(job.payload)
        return this.outcome(
          job,
          lease.recoveryEpoch && lease.armedUntil > Date.now()
            ? { rescheduleAt: lease.armedUntil }
            : undefined
        )
      }
      // A scan beginning just before the deadline must retain another scan even
      // when storage returns after it; admission may have committed meanwhile.
      const now = await this.host.run(Clock.currentTimeMillis)
      const pending = (await this.host.run(this.host.nextWake())) !== undefined
      let outcome: LifecycleJobOutcome
      for (const command of observeCommunicationDiscovery(job.payload, {
        now,
        pending,
      })) {
        if (command.type === "wake") await this.wake()
        else outcome = { rescheduleAt: command.at }
      }
      return this.outcome(job, outcome)
    }
    const state = await this.recoveryState()
    if (
      !this.owns(job) ||
      state.recovery?.epoch === owner.token ||
      state.retiredEpoch === owner.token
    )
      return this.outcome(job, undefined)
    let dispatch = this.dispatches.get(owner.token)
    if (dispatch && dispatch.job !== job) {
      // A hung SDK replacement does not own this live dispatch or its retry
      // budget. The durable domain claim independently forbids warm takeover.
      return this.outcome(job, { rescheduleAt: Date.now() + 1000 })
    }
    if (!dispatch) {
      const discovery = this.current(discoveryId)
      dispatch = {
        job,
        wakeRequested: false,
        discoveryToken: discovery ? readJob(discovery).token : null,
      }
      this.dispatches.set(owner.token, dispatch)
    }
    dispatch.receipt = undefined
    try {
      const next = await this.host.step((attempt) => {
        dispatch.receipt = attempt
      })
      this.dispatches.delete(owner.token)
      return this.outcome(
        job,
        dispatch.wakeRequested
          ? { rescheduleAt: Math.min(next ?? Infinity, Date.now()) }
          : next === undefined
            ? undefined
            : { rescheduleAt: next }
      )
    } finally {
      this.host.notify?.()
    }
  }
  async onJobError(
    { job }: LifecycleJobContext,
    error: unknown
  ): Promise<LifecycleJobOutcome> {
    const owner = readJob(job)
    await this.host.run(
      Effect.logError("Communication job exhausted", { job: job.id }, error)
    )
    if (job.fn === "recover") {
      if (this.owns(job)) {
        this.completedFailure = {
          job,
          recovery: {
            schemaVersion: 1,
            workflowVersion: 1,
            epoch: owner.token,
            failedAt: Date.now(),
            discoveryToken: owner.token,
            message:
              "Mailbox discovery stopped after three failed attempts. Retry the mailbox to continue pending work.",
          },
        }
        try {
          await this.persistFailure()
        } finally {
          this.host.notify?.()
        }
      }
      return this.outcome(job, undefined)
    }
    const dispatch = this.dispatches.get(owner.token)
    if (!dispatch || dispatch.job !== job) return this.outcome(job, undefined)
    try {
      if (!dispatch.receipt) {
        if (this.owns(job)) {
          this.completedFailure = {
            job,
            recovery: {
              schemaVersion: 1,
              workflowVersion: 1,
              epoch: owner.token,
              failedAt: Date.now(),
              discoveryToken: dispatch.discoveryToken,
              message:
                "Mailbox processing stopped after three failed attempts. Retry the mailbox to continue pending work.",
            },
          }
          await this.persistFailure()
        }
        return this.outcome(job, undefined)
      }
      const result = await this.host.run(
        Effect.exit(
          this.host.exhaust(dispatch.receipt, error, () => this.owns(job))
        )
      )
      if (Exit.isSuccess(result) && !result.value) {
        // A newer Stop or explicit recovery changed the domain revision while
        // the failed pass joined. Continue only that still-eligible domain work.
        const next = await this.host.run(this.host.nextWake())
        if (next !== undefined) return this.outcome(job, { rescheduleAt: next })
      }
      if (Exit.isFailure(result))
        await this.host.run(
          Effect.logError(
            "Communication control persistence is unconfirmed",
            result.cause
          )
        )
    } finally {
      this.dispatches.delete(owner.token)
      this.host.notify?.()
    }
    // Failure consumes this job's three attempts. Discovery does not authorize
    // the exhausted root; only a revisioned explicit recovery may clear it.
    return this.outcome(job, undefined)
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
