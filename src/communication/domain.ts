import { Schema } from "effect"

import {
  Envelope,
  CommunicationError,
  Outcome,
  canonicalEnvelope,
  failure,
  isRequest,
  terminal,
  MAX_OPEN_TASKS,
  MAX_RECORDS,
  MAX_TASK_MS,
  RESULT_WINDOW_MS,
  type Identity,
  Task,
  Delivery,
  LegacyTask,
  LegacyDelivery,
  STOP_DEADLINE_MS,
  type DiscoveryAdmission,
  type ControlAttempt,
} from "./contracts"
import { advanceTask } from "./task.machine"
export { newTask, claimTask, requireFinish } from "./task.machine"
export {
  newDelivery,
  claimDelivery,
  acknowledge,
  deliveryFailed,
  retryDelivery,
} from "./outbox.machine"

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
  return { envelope }
}
export function receiveCancellation(
  task: Task,
  envelope: Envelope,
  receivedAt: number
): Task | undefined {
  if (task.direction !== "incoming")
    throw failure("forbidden", "Only the requesting bot can cancel this task.")
  requireSameTask(envelope, task, false)
  const next = advanceTask(task, { type: "CANCEL", now: receivedAt })
  return next.revision === task.revision ? undefined : next
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
  const next = advanceTask(task, {
    type: "RESULT",
    outcome: envelope.payload.outcome,
  })
  return next.revision === task.revision ? undefined : next
}
export const resumable = (task: Task) =>
  task.direction === "outgoing" &&
  terminal(task) &&
  !task.resumed &&
  !task.control.unconfirmed
export function consumeResult(
  task: Task,
  control?: ControlAttempt,
  discard = false
): Task {
  const next = advanceTask(task, {
    type: "CONSUME",
    taskId: control?.taskId ?? task.id,
    owner: control?.owner ?? null,
    revision: control?.revision ?? task.revision,
    discard,
    phase: control?.phase ?? task.control.phase,
  })
  if (next.revision === task.revision)
    throw failure("stale", "This continuation no longer owns the task.")
  return next
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
  const cancelled = advanceTask(task, { type: "CANCEL", now })
  return { envelope, task: cancelled }
}
export function requireRetryableTask(task: Task) {
  if (task.cancelRequested || terminal(task))
    throw failure("stale", "Stopped or finished requests cannot be retried.")
}
export const expireTask = (task: Task, now = task.request.deadline): Task =>
  advanceTask(task, { type: "EXPIRE", now })

export function requireDiscovery(
  options: DiscoveryAdmission | undefined,
  now: number
) {
  if (
    !options ||
    !Number.isSafeInteger(options.discoveryDeadline) ||
    options.discoveryDeadline <= now
  )
    throw failure(
      "expired",
      "Mailbox discovery expired before admission. Prepare the same request again."
    )
}

function validControlFacts(task: Task) {
  return !(
    (task.control.owner !== null && task.control.deadline === null) ||
    (task.direction === "outgoing" &&
      task.control.owner !== null &&
      (task.control.phase !== "continuation" || !terminal(task))) ||
    (task.control.phase === "continuation" && task.direction !== "outgoing") ||
    (task.control.owner === null && task.control.deadline !== null) ||
    (task.stop.status === "pending" && task.stop.deadline === null)
  )
}
function validateTaskFacts(task: Task) {
  if (
    task.id !== task.request.taskId ||
    task.id !== task.request.id ||
    !isRequest(task.request) ||
    (task.direction === "outgoing" &&
      ["accepted", "running"].includes(task.status)) ||
    (task.direction === "incoming" && task.status === "waiting") ||
    terminal(task) !== (task.outcome !== null) ||
    (task.outcome !== null && task.status !== task.outcome.status) ||
    !validControlFacts(task) ||
    (task.status === "cancelling" && !task.cancelRequested)
  )
    throw new Error("Invalid task combinations")
}

/** Explicit compatible conversion, never recovery or ownership acquisition. */
export function readTask(raw: unknown): Task {
  try {
    if (!raw || typeof raw !== "object") throw new Error("Invalid task")
    const record = raw as Record<string, unknown>
    if (
      record.schemaVersion !== undefined ||
      record.workflowVersion !== undefined
    ) {
      const task = Schema.decodeUnknownSync(Task)(raw)
      validateTaskFacts(task)
      return task
    }
    const legacy = Schema.decodeUnknownSync(LegacyTask)(raw)
    const needsStop =
      legacy.cancelRequested ||
      legacy.status === "cancelled" ||
      legacy.status === "cancelling"
    return readTask({
      ...legacy,
      schemaVersion: 1,
      workflowVersion: 1,
      control: {
        owner: null,
        phase: needsStop
          ? "stop"
          : legacy.status === "running"
            ? "observe"
            : "submit",
        deadline: null,
        attempts: 0,
        unconfirmed: false,
      },
      stop: {
        status: needsStop
          ? terminal(legacy as Task)
            ? "unconfirmed"
            : "pending"
          : "none",
        attempts: 0,
        deadline: needsStop ? legacy.request.deadline + STOP_DEADLINE_MS : null,
        nextAt: needsStop && !terminal(legacy as Task) ? 0 : null,
      },
    })
  } catch (cause) {
    if (Schema.is(CommunicationError)(cause)) throw cause
    throw failure(
      "incompatible",
      "Incompatible communication task data. Retain the row and upgrade or repair its version before continuing."
    )
  }
}
export function readDelivery(raw: unknown): Delivery {
  try {
    if (!raw || typeof raw !== "object") throw new Error("Invalid delivery")
    const record = raw as Record<string, unknown>
    const delivery =
      record.schemaVersion !== undefined || record.workflowVersion !== undefined
        ? Schema.decodeUnknownSync(Delivery)(raw)
        : Schema.decodeUnknownSync(Delivery)({
            ...Schema.decodeUnknownSync(LegacyDelivery)(raw),
            schemaVersion: 1,
            workflowVersion: 1,
          })
    const scheduled =
      delivery.status === "pending" || delivery.status === "delivering"
    if (
      delivery.attempts > delivery.attemptLimit ||
      scheduled !== (delivery.nextAt !== null) ||
      (delivery.status === "delivering" && delivery.attempts === 0) ||
      (delivery.status === "accepted") !== (delivery.receipt !== null)
    )
      throw new Error("Invalid delivery combinations")
    if (
      delivery.receipt &&
      (delivery.receipt.id !== delivery.envelope.id ||
        delivery.receipt.taskId !== delivery.envelope.taskId)
    )
      throw new Error("Invalid delivery receipt")
    return delivery
  } catch {
    throw failure(
      "incompatible",
      "Incompatible communication outbox data. Retain the row and upgrade or repair its version before continuing."
    )
  }
}
