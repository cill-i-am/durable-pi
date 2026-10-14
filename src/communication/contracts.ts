import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
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
export const Task = Schema.Struct({
  id: MessageId,
  direction: Schema.Literals(["incoming", "outgoing"]),
  request: Envelope,
  status: TaskStatus,
  outcome: Schema.NullOr(Outcome),
  revision: Schema.Int,
  leaseUntil: Schema.NullOr(Time),
  resumed: Schema.Boolean,
  cancelRequested: Schema.Boolean,
})
export type Task = typeof Task.Type
export const Delivery = Schema.Struct({
  envelope: Envelope,
  status: Schema.Literals([
    "pending",
    "delivering",
    "accepted",
    "failed",
    "expired",
  ]),
  attempts: Schema.Int,
  attemptLimit: Schema.Int,
  nextAt: Schema.NullOr(Time),
  error: Schema.NullOr(Schema.String),
  receipt: Schema.NullOr(Receipt),
})
export type Delivery = typeof Delivery.Type
export class CommunicationError extends Schema.TaggedError<CommunicationError>()(
  "CommunicationError",
  {
    code: Schema.Literals([
      "invalid",
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

export class MailboxRpc extends RpcGroup.make(
  Rpc.make("deliver", {
    payload: { envelope: Envelope },
    success: Receipt,
    error: CommunicationError,
  }),
  Rpc.make("permit", {
    payload: { envelope: Envelope },
    success: Schema.Boolean,
    error: CommunicationError,
  }),
  Rpc.make("prove", {
    payload: { envelope: Envelope },
    success: Schema.Boolean,
    error: CommunicationError,
  })
) {}

export const MAX_TASK_MS = 60 * 60 * 1000
export const RESULT_WINDOW_MS = 24 * 60 * 60 * 1000
export const MAX_ATTEMPTS = 8
export const LEASE_MS = 30000
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

export const MailboxView = Schema.Struct({
  tasks: Schema.Array(Task),
  deliveries: Schema.Array(Delivery),
})
export type MailboxView = typeof MailboxView.Type
export const MailboxControl = Schema.Struct({
  id: MessageId,
  action: Schema.Literals(["cancel", "retry"]),
})
