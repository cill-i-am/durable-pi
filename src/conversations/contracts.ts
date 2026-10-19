import * as Schema from "effect/Schema"

import { AccessState } from "../access/contracts"
import { Address } from "../coordination/contracts"
import { Profile, JobType, ResolvedRoute } from "../inference/policy"
import { SummaryIssue } from "../memory/domain"
import { MessageProvenance } from "../messages/identity"
import { SkillReference } from "../skills/contracts"
import { FileInfo, FileSelection } from "../workspace/files"
import { RuntimeStatus } from "./status"

export const ConversationCursor = Schema.String.check(
  Schema.isPattern(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
  )
).pipe(Schema.brand("ConversationCursor"))
export type ConversationCursor = typeof ConversationCursor.Type

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
export const TurnOrigin = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("coordination"),
    turnId: Schema.String,
    messageId: Schema.String,
    from: Schema.optional(Address),
  }),
  Schema.Struct({
    kind: Schema.Literal("whatsapp"),
    sender: Schema.String,
    messageId: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("email"),
    sender: Schema.String,
    subject: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("background"),
    groupId: Schema.Number,
    turnId: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("communication"),
    taskId: Schema.String,
    turnId: Schema.String,
  }),
])
export type TurnOrigin = typeof TurnOrigin.Type
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
    provenance: Schema.optional(MessageProvenance),
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
  preparingFiles: Schema.optional(Schema.Boolean),
  provenance: Schema.optional(MessageProvenance),
  origin: Schema.optional(TurnOrigin),
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
  replyFiles: Schema.optional(Schema.Array(FileInfo)),
  activity: Schema.optional(Schema.Array(TimelineItem)),
  steering: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        text: Schema.String,
        provenance: Schema.optional(MessageProvenance),
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
export const ConversationMetadata = Schema.Struct({
  runtime: Schema.optional(RuntimeStatus),
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
  ...ConversationMetadata.fields,
  turns: Schema.Array(VisibleTurn),
})
export type ChatState = typeof ChatState.Type
export const ConversationFrame = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), state: ChatState }),
  Schema.Struct({
    type: Schema.Literal("update"),
    turns: Schema.Array(VisibleTurn),
    ids: Schema.Array(Schema.String),
    meta: Schema.optional(ConversationMetadata),
  }),
])
export type ConversationFrame = typeof ConversationFrame.Type
