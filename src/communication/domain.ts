import { Schema } from "effect"

import {
  Envelope,
  Outcome,
  Receipt,
  canonicalEnvelope,
  failure,
  isRequest,
  terminal,
  LEASE_MS,
  MAX_ATTEMPTS,
  MAX_OPEN_TASKS,
  MAX_RECORDS,
  MAX_TASK_MS,
  RESULT_WINDOW_MS,
  type Delivery,
  type Identity,
  type Task,
} from "./contracts"

function decodeInput<T>(decode: () => T): T {
  try {
    return decode()
  } catch (cause) {
    if (Schema.isSchemaError(cause))
      throw failure("invalid", "Invalid mailbox input.")
    throw cause
  }
}
export function validateEnvelope(raw: Envelope): Envelope {
  const envelope = decodeInput(() => Schema.decodeUnknownSync(Envelope)(raw))
  if (
    envelope.from === envelope.to ||
    envelope.depth !== 1 ||
    envelope.deadline <= envelope.createdAt ||
    envelope.deadline - envelope.createdAt >
      (isRequest(envelope) ? MAX_TASK_MS : RESULT_WINDOW_MS)
  )
    throw failure("invalid", "Invalid delegation bounds.")
  if (
    isRequest(envelope) &&
    (envelope.taskId !== envelope.id || envelope.id.length > 160)
  )
    throw failure("invalid", "Request and task identities must match.")
  return envelope
}
export function requireParty(
  envelope: Envelope,
  self: Identity,
  direction: "sender" | "recipient"
) {
  if (
    envelope.owner !== self.owner ||
    (direction === "sender" ? envelope.from : envelope.to) !== self.bot
  )
    throw failure(
      "forbidden",
      direction === "sender"
        ? "Sender does not match this bot."
        : "Recipient does not match this bot."
    )
}
export function requireTimely(
  envelope: Envelope,
  now: number,
  kind: "Task" | "Message"
) {
  if (envelope.deadline <= now || envelope.createdAt > now + 60000)
    throw failure(
      "expired",
      `${kind} deadline has passed or its creation time is invalid.`
    )
}
export function requireRetainedCapacity(
  records: number,
  deliveryRecords: boolean
) {
  if (records >= MAX_RECORDS * (deliveryRecords ? 3 : 1))
    throw failure(
      "limit",
      "This bot's retained mailbox is full. Existing receipts are preserved."
    )
}
export function requireOpenCapacity(records: number) {
  if (records >= MAX_OPEN_TASKS)
    throw failure(
      "limit",
      "This bot already has three unfinished communication tasks."
    )
}
export function requireFanout(records: number) {
  if (records >= MAX_OPEN_TASKS)
    throw failure(
      "limit",
      "This request already delegated its three permitted tasks."
    )
}
export function requireSameTask(
  envelope: Envelope,
  task: Task,
  reverse: boolean
) {
  if (
    envelope.owner !== task.request.owner ||
    envelope.taskId !== task.id ||
    envelope.correlationId !== task.request.correlationId ||
    envelope.causationId !== task.request.id ||
    envelope.from !== (reverse ? task.request.to : task.request.from) ||
    envelope.to !== (reverse ? task.request.from : task.request.to)
  )
    throw failure("conflict", "Message does not belong to this task.")
}
export function replayDelivery(
  previous: Delivery,
  envelope: Envelope
): Delivery {
  if (canonicalEnvelope(previous.envelope) !== canonicalEnvelope(envelope))
    throw failure("conflict", "Message identity already has different content.")
  return previous
}
export const newDelivery = (envelope: Envelope, now: number): Delivery => ({
  envelope,
  status: "pending",
  attempts: 0,
  attemptLimit: MAX_ATTEMPTS,
  nextAt: now,
  error: null,
  receipt: null,
})
export const newTask = (
  request: Envelope,
  direction: Task["direction"]
): Task => ({
  id: request.taskId,
  direction,
  request,
  status: direction === "incoming" ? "accepted" : "waiting",
  outcome: null,
  revision: 0,
  leaseUntil: null,
  resumed: false,
  cancelRequested: false,
})
export function taskResult(task: Task, raw: Outcome, now: number) {
  const outcome = decodeInput(() => Schema.decodeUnknownSync(Outcome)(raw))
  const envelope: Envelope = {
    ...task.request,
    id: `result:${task.id}`,
    from: task.request.to,
    to: task.request.from,
    causationId: task.request.id,
    createdAt: now,
    deadline: now + RESULT_WINDOW_MS,
    payload: { kind: "result", outcome },
  }
  const finished: Task = {
    ...task,
    status: outcome.status,
    outcome,
    revision: task.revision + 1,
    leaseUntil: null,
  }
  return { envelope, task: finished }
}
export function receiveCancellation(
  task: Task,
  envelope: Envelope
): Task | undefined {
  if (task.direction !== "incoming")
    throw failure("forbidden", "Only the requesting bot can cancel this task.")
  requireSameTask(envelope, task, false)
  return terminal(task)
    ? undefined
    : {
        ...task,
        cancelRequested: true,
        status: "cancelling",
        revision: task.revision + 1,
        leaseUntil: null,
      }
}
export function receiveResult(
  task: Task,
  envelope: Envelope
): Task | undefined {
  if (task.direction !== "outgoing")
    throw failure("forbidden", "Unexpected result direction.")
  requireSameTask(envelope, task, true)
  if (envelope.payload.kind !== "result")
    throw new Error("Result transition requires a result envelope")
  return terminal(task)
    ? undefined
    : {
        ...task,
        status: envelope.payload.outcome.status,
        outcome: envelope.payload.outcome,
        revision: task.revision + 1,
      }
}
export const resumable = (task: Task) =>
  task.direction === "outgoing" && terminal(task) && !task.resumed
export const consumeResult = (task: Task): Task => ({
  ...task,
  resumed: true,
  revision: task.revision + 1,
})
export function claimDelivery(delivery: Delivery, now: number): Delivery {
  if (
    delivery.envelope.deadline <= now ||
    delivery.attempts >= delivery.attemptLimit
  )
    return {
      ...delivery,
      status: delivery.envelope.deadline <= now ? "expired" : "failed",
      nextAt: null,
      error: "Delivery deadline or attempt budget exhausted.",
    }
  return {
    ...delivery,
    status: "delivering",
    attempts: delivery.attempts + 1,
    nextAt: now + LEASE_MS,
  }
}
export function acknowledge(
  delivery: Delivery,
  attempt: number,
  raw: Receipt
): Delivery | undefined {
  if (delivery.attempts !== attempt || delivery.status !== "delivering") return
  const receipt = decodeInput(() => Schema.decodeUnknownSync(Receipt)(raw))
  if (
    receipt.id !== delivery.envelope.id ||
    receipt.taskId !== delivery.envelope.taskId
  )
    throw failure("conflict", "Acknowledgment belongs to another message.")
  return { ...delivery, status: "accepted", receipt, nextAt: null, error: null }
}
export function deliveryFailed(
  delivery: Delivery,
  attempt: number,
  now: number,
  delay: number,
  permanent: boolean
): Delivery | undefined {
  if (delivery.attempts !== attempt || delivery.status !== "delivering") return
  const expired = delivery.envelope.deadline <= now
  const done = permanent || expired || attempt >= delivery.attemptLimit
  return {
    ...delivery,
    status: expired ? "expired" : done ? "failed" : "pending",
    nextAt: done ? null : Math.min(delivery.envelope.deadline, now + delay),
    error: permanent
      ? "Delivery was rejected. Inspect this message before retrying."
      : "Delivery could not be confirmed; retries preserve its identity.",
  }
}
export const claimTask = (task: Task, now: number): Task => ({
  ...task,
  status: task.cancelRequested ? "cancelling" : "running",
  revision: task.revision + 1,
  leaseUntil: now + LEASE_MS,
})
export function requireFinish(
  task: Task,
  revision: number,
  outcome: Outcome,
  now: number
) {
  if (
    task.direction !== "incoming" ||
    task.revision !== revision ||
    terminal(task)
  )
    throw failure("stale", "This execution no longer owns the task.")
  if (task.cancelRequested && outcome.status !== "cancelled")
    throw failure("stale", "Cancellation must be reconciled before completion.")
  if (
    now >= task.request.deadline &&
    !["cancelled", "expired"].includes(outcome.status)
  )
    throw failure("expired", "The task deadline has passed.")
}
export function cancelTask(task: Task, now: number) {
  if (task.direction !== "outgoing")
    throw failure("forbidden", "Cancel from the requesting bot.")
  if (terminal(task) || task.cancelRequested) return
  const envelope: Envelope = {
    ...task.request,
    id: `cancel:${task.id}`,
    causationId: task.id,
    createdAt: now,
    deadline: now + RESULT_WINDOW_MS,
    payload: {
      kind: "cancel",
      reason: "The owner or originating task requested cancellation.",
    },
  }
  const cancelled: Task = {
    ...task,
    cancelRequested: true,
    status: "cancelling",
    revision: task.revision + 1,
  }
  return { envelope, task: cancelled }
}
export function retryDelivery(
  delivery: Delivery,
  now: number
): Delivery | undefined {
  if (["pending", "delivering", "accepted"].includes(delivery.status)) return
  if (delivery.envelope.deadline <= now)
    throw failure("expired", "Expired messages cannot be retried.")
  return {
    ...delivery,
    status: "pending",
    attemptLimit: delivery.attempts + MAX_ATTEMPTS,
    nextAt: now,
    error: null,
  }
}
export function requireRetryableTask(task: Task) {
  if (task.cancelRequested || terminal(task))
    throw failure("stale", "Stopped or finished requests cannot be retried.")
}
export const expireTask = (task: Task): Task => ({
  ...task,
  status: "expired",
  revision: task.revision + 1,
  outcome: {
    status: "expired",
    text: task.cancelRequested
      ? "Cancellation was requested; termination could not be confirmed before the deadline."
      : "The result was not confirmed before the task deadline.",
  },
})
