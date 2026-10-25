import { Schema } from "effect"

import { AgentId } from "../agents/domain"

const text = (max: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max))
export const MessageId = text(180).check(Schema.isPattern(/^[a-zA-Z0-9:_-]+$/))
const Time = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const Identity = Schema.Struct({ owner: text(180), bot: AgentId })
export type Identity = typeof Identity.Type
export const Outcome = Schema.Struct({
  status: Schema.Literals([
    "completed",
    "failed",
    "expired",
    "cancelled",
    "awaiting_input",
  ]),
  text: text(16000),
})
export type Outcome = typeof Outcome.Type
export const RequestPayload = Schema.Struct({
  kind: Schema.Literals(["task", "question"]),
  objective: text(1000),
  context: Schema.String.check(Schema.isMaxLength(12000)),
})
export const Payload = Schema.Union([
  RequestPayload,
  Schema.Struct({ kind: Schema.Literal("result"), outcome: Outcome }),
  Schema.Struct({ kind: Schema.Literal("cancel"), reason: text(500) }),
])
export const Envelope = Schema.Struct({
  version: Schema.Literal(1),
  id: MessageId,
  owner: Identity.fields.owner,
  from: AgentId,
  to: AgentId,
  taskId: MessageId,
  correlationId: MessageId,
  causationId: MessageId,
  createdAt: Time,
  deadline: Time,
  depth: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  payload: Payload,
})
export type Envelope = typeof Envelope.Type
export const Receipt = Schema.Struct({
  id: MessageId,
  taskId: MessageId,
  acceptedAt: Time,
})
export type Receipt = typeof Receipt.Type
export const TaskStatus = Schema.Literals([
  "accepted",
  "running",
  "waiting",
  "completed",
  "failed",
  "expired",
  "cancelling",
  "cancelled",
  "awaiting_input",
])
export const LegacyTask = Schema.Struct({
  id: MessageId,
  direction: Schema.Literals(["incoming", "outgoing"]),
  request: Envelope,
  status: TaskStatus,
  outcome: Schema.NullOr(Outcome),
  revision: Time,
  leaseUntil: Schema.NullOr(Time),
  resumed: Schema.Boolean,
  cancelRequested: Schema.Boolean,
})
export const ControlPhase = Schema.Literals([
  "submit",
  "observe",
  "stop",
  "continuation",
])
export const TaskControl = Schema.Struct({
  owner: Schema.NullOr(text(180)),
  phase: ControlPhase,
  deadline: Schema.NullOr(Time),
  attempts: Time,
  unconfirmed: Schema.Boolean,
})
export const TaskStop = Schema.Struct({
  status: Schema.Literals(["none", "pending", "confirmed", "unconfirmed"]),
  attempts: Time,
  deadline: Schema.NullOr(Time),
  nextAt: Schema.NullOr(Time),
})
export const Task = Schema.Struct({
  ...LegacyTask.fields,
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  control: TaskControl,
  stop: TaskStop,
})
export type Task = typeof Task.Type
export const ControlAttempt = Schema.Struct({
  taskId: MessageId,
  owner: text(180),
  revision: Time,
  phase: ControlPhase,
})
export type ControlAttempt = typeof ControlAttempt.Type
export const TaskRelease = Schema.Struct({
  taskId: MessageId,
  owner: text(180),
  revision: Time,
  now: Time,
  outcome: Schema.optional(Outcome),
  failed: Schema.optional(Schema.Boolean),
  stop: Schema.optional(Schema.Literals(["confirmed", "unconfirmed"])),
})
export type TaskRelease = typeof TaskRelease.Type
export type TaskClaim = { owner: string; deadline: number }
export type DiscoveryAdmission = { discoveryDeadline: number }
export const LegacyDelivery = Schema.Struct({
  envelope: Envelope,
  status: Schema.Literals([
    "pending",
    "delivering",
    "accepted",
    "failed",
    "expired",
  ]),
  attempts: Time,
  attemptLimit: Time,
  nextAt: Schema.NullOr(Time),
  error: Schema.NullOr(Schema.String),
  receipt: Schema.NullOr(Receipt),
})
export const Delivery = Schema.Struct({
  ...LegacyDelivery.fields,
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
})
export type Delivery = typeof Delivery.Type
export class CommunicationError extends Schema.TaggedError<CommunicationError>()(
  "CommunicationError",
  {
    code: Schema.Literals([
      "invalid",
      "incompatible",
      "forbidden",
      "conflict",
      "not_found",
      "limit",
      "expired",
      "stale",
      "storage",
      "transport",
    ]),
    message: Schema.String,
  }
) {}
export const failure = (code: CommunicationError["code"], message: string) =>
  new CommunicationError({ code, message })

export const MAX_TASK_MS = 60 * 60 * 1000
export const RESULT_WINDOW_MS = 24 * 60 * 60 * 1000
export const MAX_ATTEMPTS = 8
export const LEASE_MS = 30000
export const CONTROL_ATTEMPTS = 3
export const STOP_ATTEMPTS = 5
export const STOP_DEADLINE_MS = 300000
export const MAX_OPEN_TASKS = 3
export const MAX_RECORDS = 10000
export const canonicalEnvelope = Schema.encodeSync(
  Schema.fromJsonString(Envelope)
)
export const isRequest = (e: Envelope) =>
  e.payload.kind === "task" || e.payload.kind === "question"
export const terminal = (t: Task) =>
  ["completed", "failed", "expired", "cancelled", "awaiting_input"].includes(
    t.status
  )

export const MailboxRecovery = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  epoch: MessageId,
  failedAt: Time,
  discoveryToken: Schema.NullOr(Schema.String),
  message: text(500),
})
export type MailboxRecovery = typeof MailboxRecovery.Type
export const MailboxView = Schema.Struct({
  recovery: Schema.NullOr(MailboxRecovery),
  tasks: Schema.Array(Task),
  deliveries: Schema.Array(Delivery),
})
export type MailboxView = typeof MailboxView.Type
export const MailboxControl = Schema.Struct({
  id: MessageId,
  action: Schema.Literals(["cancel", "retry", "retry_mailbox"]),
})
