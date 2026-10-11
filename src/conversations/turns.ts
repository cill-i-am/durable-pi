import type { SkillReference } from "../skills/contracts"
import { Schema } from "effect"
import type { ChatTurn, TurnOrigin } from "./contracts"
import type { AttachmentContent, FileInfo } from "../workspace/files"

import { ModelSettings, ThinkingLevel } from "../inference/selection"
import type { ResolvedRoute, Profile, JobType } from "../inference/policy"

export { ModelSettings, ThinkingLevel }
export const ModelSelection = Schema.Struct({
  ...ModelSettings.fields,
  settingsRevision: Schema.Number,
})
export type ModelSelection = typeof ModelSelection.Type
export type SubmissionMode = "followUp" | "steer"
export type Delivery =
  "queued" | "accepted" | "consumed" | "answered" | "unanswered"
export type Turn = ChatTurn & {
  origin?: TurnOrigin
  parent_id: string | null
  mode: SubmissionMode
  delivery: Delivery
  model: string | null
  thinking: ThinkingLevel | null
  routing?: ResolvedRoute | null
  revision: number
  creation: string | null
  attachments: readonly FileInfo[]
  skills?: readonly SkillReference[]
  skill_context?: string
  input: readonly AttachmentContent[]
}
export type Submission = {
  /** Host-only event identity; never accepted by the public SendInput schema. */
  origin?: TurnOrigin
  operationId: string
  text: string
  mode?: SubmissionMode
  retryOf?: string
  files?: readonly string[]
  profile?: Profile
  job?: JobType
}
export class ConversationConflict extends Schema.TaggedError<ConversationConflict>()(
  "ConversationConflict",
  { message: Schema.String }
) {}
export class ConversationFull extends Schema.TaggedError<ConversationFull>()(
  "ConversationFull",
  {}
) {}
export const isPending = (turn: Pick<Turn, "status">) =>
  ["queued", "preparing", "running", "stopping"].includes(turn.status)
