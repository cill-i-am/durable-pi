import type {
  LifecycleJob,
  LifecycleJobOutcome,
  LifecycleJobPushOptions,
} from "agents/lifecycle"
import { Schema } from "effect"

import {
  armConversationDiscovery,
  readConversationDiscovery,
} from "../recovery-discovery.machine"

const PumpOwner = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  token: Schema.String.check(Schema.isNonEmpty()),
})
export const conversationPumpId = "pump"
export const conversationDiscoveryId = "conversation-recovery"
const retry = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 }

export function readConversationJob(job: LifecycleJob) {
  if (job.id === conversationPumpId && job.fn === "pump") {
    // The prior TurnRunner persisted no payload. Preserve its identity until
    // its ordinary job completes; a future format requires an explicit migration.
    return job.payload === undefined || job.payload === null
      ? { token: `legacy:${job.createdAt}:${job.time}` }
      : Schema.decodeUnknownSync(PumpOwner)(job.payload)
  }
  if (job.id === conversationDiscoveryId && job.fn === "recover")
    return readConversationDiscovery(job.payload)
  throw new Error(`Unsupported conversation job: ${job.id}/${job.fn}`)
}

export function conversationPumpJob(
  time: number,
  token: string
): LifecycleJobPushOptions {
  return {
    id: conversationPumpId,
    fn: "pump",
    payload: { schemaVersion: 1, workflowVersion: 1, token },
    time,
    singleflight: true,
    recoveryLoop: true,
    hungTimeoutSeconds: 600,
    retry,
  }
}

export function conversationDiscoveryJob(
  prior: LifecycleJob | undefined,
  now: number,
  token: string
) {
  const deadline = now + 60_000
  const job: LifecycleJobPushOptions = {
    id: conversationDiscoveryId,
    fn: "recover",
    payload: armConversationDiscovery(prior?.payload, deadline, token),
    time: Math.min(now, prior?.time ?? Infinity),
    singleflight: true,
    recoveryLoop: true,
    retry,
  }
  return { job, deadline }
}

/** The SDK running bit cannot distinguish a newer same-ID job. Keep its intent. */
export function conversationJobOutcome(
  latest: LifecycleJob | undefined,
  completed: LifecycleJob,
  outcome: LifecycleJobOutcome
) {
  return latest &&
    readConversationJob(latest).token !== readConversationJob(completed).token
    ? { rescheduleAt: latest.time }
    : outcome
}
