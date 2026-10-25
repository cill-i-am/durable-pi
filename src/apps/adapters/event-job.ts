import type {
  LifecycleJob,
  LifecycleJobOutcome,
  LifecycleJobPushOptions,
} from "agents/lifecycle"

import { readAppDiscovery } from "../discovery.machine"

export const appEventJobId = "app-events:pump"
const retry = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 }
export const readAppEventJob = (job: LifecycleJob) => {
  if (job.id !== appEventJobId || job.fn !== "pump")
    throw new Error("Unsupported app delivery job")
  return readAppDiscovery(
    job.payload ?? {
      schemaVersion: 1,
      workflowVersion: 1,
      state: "armed",
      token: `legacy:${job.createdAt}:${job.time}`,
      armedUntil: Math.max(job.createdAt, job.time) + 60_000,
    }
  )
}

export function appEventJob(
  payload: ReturnType<typeof readAppEventJob>,
  time: number
): LifecycleJobPushOptions {
  return {
    id: appEventJobId,
    fn: "pump",
    payload,
    time,
    singleflight: true,
    recoveryLoop: true,
    hungTimeoutSeconds: 600,
    retry,
  }
}

/** Preserve a newer lease or its exhausted state when an old callback completes. */
export function appEventOutcome(
  current: LifecycleJob | undefined,
  job: LifecycleJob,
  at?: number
): LifecycleJobOutcome {
  if (current) {
    const latest = readAppEventJob(current),
      completed = readAppEventJob(job)
    if (latest.token !== completed.token || latest.state !== completed.state)
      return { rescheduleAt: current.time }
  }
  return at === undefined ? undefined : { rescheduleAt: at }
}
