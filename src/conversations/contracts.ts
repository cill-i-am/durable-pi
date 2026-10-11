import { AccessState } from "../access/contracts"
import { SkillReference } from "../skills/contracts"
import * as Schema from "effect/Schema"
import { FileInfo, FileSelection } from "../workspace/files"

import { Profile, JobType, ResolvedRoute } from "../inference/policy"
import { SummaryIssue } from "../memory/domain"

export const SendInput = Schema.Struct({
  operationId: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/i)),
  text: Schema.String.check(Schema.isMaxLength(30_000)),
  files: Schema.optional(FileSelection),
  profile: Schema.optional(Profile),
  job: Schema.optional(JobType),
  mode: Schema.optional(Schema.Literals(["followUp", "steer"])),
})
export const CancelInput = Schema.Struct({
  operationId: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/i)),
})
export type ChatTurn = {
  id: string
  text: string
  status:
    | "queued"
    | "preparing"
    | "running"
    | "stopping"
    | "done"
    | "failed"
    | "cancelled"
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
    type: Schema.Literal("steer"),
    text: Schema.String,
    attachments: Schema.optional(Schema.Array(FileInfo)),
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
  routing: Schema.optional(Schema.NullOr(ResolvedRoute)),
  skills: Schema.optional(Schema.Array(SkillReference)),
  id: Schema.String,
  text: Schema.String,
  status: Schema.Literals([
    "queued",
    "preparing",
    "running",
    "stopping",
    "done",
    "failed",
    "cancelled",
  ]),
  answer: Schema.String,
  error: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  attachments: Schema.optional(Schema.Array(FileInfo)),
  activity: Schema.optional(Schema.Array(TimelineItem)),
  steering: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        text: Schema.String,
        attachments: Schema.optional(Schema.Array(FileInfo)),
        delivery: Schema.Literals([
          "queued",
          "accepted",
          "consumed",
          "answered",
          "unanswered",
        ]),
      })
    )
  ),
})
const Metadata = Schema.Struct({
  access: Schema.optional(AccessState),
  model: Schema.String,
  thinking: Schema.optional(Schema.String),
  settingsRevision: Schema.optional(Schema.Number),
  connected: Schema.Boolean,
  memory: Schema.Struct({
    messages: Schema.Number,
    summaries: Schema.Number,
    ready: Schema.Boolean,
    issues: Schema.optional(Schema.Array(SummaryIssue)),
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
