import {
  LifecycleCapability,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from "agents/lifecycle"
import { Clock, Effect, Exit } from "effect"

import {
  armBackgroundRecovery,
  observeBackgroundRecovery,
  readBackgroundRecovery,
} from "../background-recovery.machine"

/** Existing background capability/job identity, persisted discovery lease and
 * domain recovery only. Lifecycle remains the single physical alarm owner. */
export class BackgroundRunner<E> extends LifecycleCapability {
  constructor(
    readonly host: {
      run: <A>(work: Effect.Effect<A, E>) => Promise<A>
      step: () => Promise<number | undefined>
      exhaust: (current: () => boolean) => Effect.Effect<void, E>
      nextWake: () => Effect.Effect<number | undefined, E>
    }
  ) {
    super("background-groups")
  }
  private async schedule(time: number, deadline: number) {
    const id = "background-groups:pump"
    const prior = this.lifecycle.jobs.get(id)
    const payload = armBackgroundRecovery(
      prior?.payload,
      prior?.time ?? time,
      deadline,
      crypto.randomUUID()
    )
    await this.lifecycle.jobs.push({
      id,
      fn: "pump",
      payload,
      time: Math.min(time, prior?.time ?? Infinity),
      singleflight: true,
      recoveryLoop: true,
      hungTimeoutSeconds: 600,
      retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
    })
  }
  armBackground(deadline: number) {
    return this.schedule(deadline, deadline)
  }
  wake() {
    const now = Date.now()
    return this.schedule(now, now)
  }
  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    const now = await this.host.run(Clock.currentTimeMillis)
    const next = await this.host.step()
    const command = observeBackgroundRecovery(job.payload, job.time, {
      now,
      next: next ?? null,
    })[0]
    return command ? { rescheduleAt: command.at } : undefined
  }
  async onJobError(
    { job }: LifecycleJobContext,
    error: unknown
  ): Promise<LifecycleJobOutcome> {
    await this.host.run(
      Effect.logError("Background job exhausted", { job: job.id }, error)
    )
    const now = await this.host.run(Clock.currentTimeMillis)
    const token = readBackgroundRecovery(job.payload, job.time).token
    const current = () => {
      const latest = this.lifecycle.jobs.get(job.id)
      return (
        !!latest &&
        readBackgroundRecovery(latest.payload, latest.time).token === token
      )
    }
    const exit = await this.host.run(
      Effect.exit(
        Effect.gen({ self: this }, function* () {
          yield* this.host.exhaust(current)
          return yield* this.host.nextWake()
        })
      )
    )
    if (Exit.isFailure(exit))
      await this.host.run(
        Effect.logError(
          "Background terminal persistence is unconfirmed",
          exit.cause
        )
      )
    // Do not renew an exhausted lease after a storage outage. Domain rows remain
    // intact for explicit Stop/retry or activation reconciliation; an already
    // armed newer admission is retained and a concurrent job replacement wins.
    const next = Exit.isSuccess(exit) ? (exit.value ?? null) : null
    const command = observeBackgroundRecovery(job.payload, job.time, {
      now,
      next,
    })[0]
    return command ? { rescheduleAt: command.at } : undefined
  }
}
