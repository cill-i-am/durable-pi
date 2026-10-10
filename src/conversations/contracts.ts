import * as Schema from "effect/Schema"

export const SendInput = Schema.Struct({
  operationId: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/i)),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(30_000)),
})
export const CancelInput = Schema.Struct({
  operationId: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/i)),
})
export type ChatTurn = {
  id: string
  text: string
  status: "queued" | "preparing" | "running" | "done" | "failed" | "cancelled"
  answer: string
  error: string | null
  created_at: string
  session_id: string | null
  prompt: string | null
}
export const TimelineItem = Schema.Union([
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("text"),
    text: Schema.String,
  }),
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("thinking"),
    text: Schema.String,
  }),
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("tool"),
    name: Schema.String,
    input: Schema.String,
    output: Schema.String,
    status: Schema.Literals([
      "pending",
      "running",
      "done",
      "error",
      "interrupted",
    ]),
  }),
])
export type TimelineItem = typeof TimelineItem.Type
const VisibleTurn = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  status: Schema.Literals([
    "queued",
    "preparing",
    "running",
    "done",
    "failed",
    "cancelled",
  ]),
  answer: Schema.String,
  error: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  activity: Schema.optional(Schema.Array(TimelineItem)),
})
const Metadata = Schema.Struct({
  model: Schema.String,
  connected: Schema.Boolean,
  memory: Schema.Struct({
    messages: Schema.Number,
    summaries: Schema.Number,
    ready: Schema.Boolean,
    backup: Schema.optional(
      Schema.Struct({
        date: Schema.NullOr(Schema.String),
        error: Schema.NullOr(Schema.String),
      })
    ),
    usage: Schema.optional(
      Schema.Struct({
        input: Schema.Number,
        cached: Schema.Number,
        output: Schema.Number,
        requests: Schema.Number,
      })
    ),
    notes: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        body: Schema.String,
        source_id: Schema.Number,
        updated_at: Schema.String,
      })
    ),
  }),
})
export const ChatState = Schema.Struct({
  ...Metadata.fields,
  turns: Schema.Array(VisibleTurn),
})
export type ChatState = typeof ChatState.Type
export const ConversationFrame = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), state: ChatState }),
  Schema.Struct({
    type: Schema.Literal("update"),
    turns: Schema.Array(VisibleTurn),
    ids: Schema.Array(Schema.String),
    meta: Schema.optional(Metadata),
  }),
])
export type ConversationFrame = typeof ConversationFrame.Type
