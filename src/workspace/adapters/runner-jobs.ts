import type {
  LifecycleJob,
  LifecycleJobOutcome,
  LifecycleJobPushOptions,
} from "agents/lifecycle"

import {
  armWorkspaceDiscovery,
  readWorkspaceDiscovery,
  readWorkspacePump,
  type WorkspacePump,
} from "../discovery.machine"

export const workspacePumpId = "workspace-extraction:pump"
export const workspaceDiscoveryId = "workspace-extraction:recovery"
const retry = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 }

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
export function readWorkspaceJob(job: LifecycleJob) {
  if (job.id === workspacePumpId && job.fn === "pump") {
    // The former ExtractionRunner used no payload. Keep the same queue identity.
    return job.payload === undefined || job.payload === null
      ? pumpPayload(`legacy:${job.createdAt}:${job.time}`)
      : readWorkspacePump(job.payload)
  }
  if (job.id === workspaceDiscoveryId && job.fn === "recover")
    return readWorkspaceDiscovery(job.payload)
  throw new Error(`Unsupported Workspace job: ${job.id}/${job.fn}`)
}

export function workspacePumpJob(
  time: number,
  payload = pumpPayload(crypto.randomUUID())
): LifecycleJobPushOptions {
  return {
    id: workspacePumpId,
    fn: "pump",
    payload: { ...payload, token: crypto.randomUUID() },
    time,
    singleflight: true,
    recoveryLoop: true,
    hungTimeoutSeconds: 600,
    retry,
  }
}

export function workspaceDiscoveryJob(
  prior: LifecycleJob | undefined,
  now: number,
  token: string
) {
  const deadline = now + 60_000
  const job: LifecycleJobPushOptions = {
    id: workspaceDiscoveryId,
    fn: "recover",
    payload: armWorkspaceDiscovery(prior?.payload, deadline, token),
    time: Math.min(now, prior?.time ?? Infinity),
    singleflight: true,
    recoveryLoop: true,
    retry,
  }
  return { job, deadline }
}

export function workspaceJobOutcome(
  current: LifecycleJob | undefined,
  completed: LifecycleJob,
  result: LifecycleJobOutcome
) {
  return current &&
    readWorkspaceJob(current).token !== readWorkspaceJob(completed).token
    ? { rescheduleAt: current.time }
    : result
}
