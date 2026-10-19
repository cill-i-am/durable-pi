import { Option, Schema } from "effect"

import { ResolvedRoute, type Profile, type JobType } from "../inference/policy"
import { ModelSettings, ThinkingLevel } from "../inference/selection"
import { MessageProvenance } from "../messages/identity"
import { SkillReference } from "../skills/contracts"
import { AttachmentContent, FileInfo } from "../workspace/files"
import { TurnOrigin, type ChatTurn } from "./contracts"

export { ModelSettings, ThinkingLevel }
export const ModelSelection = Schema.Struct({
  ...ModelSettings.fields,
  settingsRevision: Schema.Number,
})
export type ModelSelection = typeof ModelSelection.Type
export type SubmissionMode = "followUp" | "steer"
export type Delivery =
  | "queued"
  | "accepted"
  | "consumed"
  | "answered"
  | "unanswered"
export type Turn = ChatTurn & {
  provenance?: MessageProvenance
  origin?: TurnOrigin
  parent_id: string | null
  mode: SubmissionMode
  delivery: Delivery
  model: string | null
  thinking: ThinkingLevel | null
  routing?: ResolvedRoute | null
  revision: number
  creation: string | null
  files_pending?: boolean
  attachments: readonly FileInfo[]
  skills?: readonly SkillReference[]
  skill_context?: string
  input: readonly AttachmentContent[]
}
/** Durable row shape. Dates and IDs keep legacy compatibility; native metadata
 * columns remain an adapter concern and may be retained alongside this shape. */
export const TurnRecord = Schema.Struct({
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
  session_id: Schema.NullOr(Schema.String),
  prompt: Schema.NullOr(Schema.String),
  parent_id: Schema.NullOr(Schema.String),
  mode: Schema.Literals(["followUp", "steer"]),
  delivery: Schema.Literals([
    "queued",
    "accepted",
    "consumed",
    "answered",
    "unanswered",
  ]),
  model: Schema.NullOr(Schema.String),
  thinking: Schema.NullOr(ThinkingLevel),
  routing: Schema.NullOr(ResolvedRoute),
  origin: Schema.optional(TurnOrigin),
  provenance: Schema.optional(MessageProvenance),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  creation: Schema.NullOr(Schema.String),
  files_pending: Schema.optional(Schema.Boolean),
  attachments: Schema.Array(FileInfo),
  input: Schema.Array(AttachmentContent),
  skills: Schema.Array(SkillReference),
  skill_context: Schema.String,
})
export type Submission = {
  provenance?: MessageProvenance
  origin?: TurnOrigin
  operationId: string
  text: string
  mode?: SubmissionMode
  retryOf?: string
  files?: readonly string[]
  profile?: Profile
  job?: JobType
}
export type PreparedMessage = {
  pending?: boolean
  files: readonly FileInfo[]
  content: readonly AttachmentContent[]
}
export type TurnOutcome = {
  id: string
  delivery: Extract<Delivery, "answered" | "unanswered">
}
export type TurnAdmission = { turn: Turn; accepted: boolean }
export class ConversationConflict extends Schema.TaggedError<ConversationConflict>()(
  "ConversationConflict",
  { message: Schema.String }
) {}
export class ConversationFull extends Schema.TaggedError<ConversationFull>()(
  "ConversationFull",
  {}
) {}
export class ConversationStorageError extends Schema.TaggedError<ConversationStorageError>()(
  "ConversationStorageError",
  { operation: Schema.String, cause: Schema.Unknown }
) {}
export type ConversationFailure =
  | ConversationConflict
  | ConversationFull
  | ConversationStorageError
const ConversationFailureSchema = Schema.Union([
  ConversationConflict,
  ConversationFull,
  ConversationStorageError,
])
/** Decode the encoded fields into the owned error class; a JS prototype is not
 * a transport contract. Schema mismatches are not conversation failures. */
export const conversationFailure = (
  cause: unknown
): ConversationFailure | undefined =>
  Option.getOrUndefined(
    Schema.decodeUnknownOption(ConversationFailureSchema)(cause)
  )
export const isPending = (turn: Pick<Turn, "status">) =>
  ["queued", "preparing", "running", "stopping"].includes(turn.status)
