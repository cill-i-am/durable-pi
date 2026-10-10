import { Schema } from "effect"
import type { ChatTurn } from "./contracts"

export const ThinkingLevel = Schema.Literals([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
])
export type ThinkingLevel = typeof ThinkingLevel.Type
export const ModelSettings = Schema.Struct({
  model: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  thinking: ThinkingLevel,
})
export type ModelSettings = typeof ModelSettings.Type
export const ModelSelection = Schema.Struct({
  ...ModelSettings.fields,
  settingsRevision: Schema.Number,
})
export type ModelSelection = typeof ModelSelection.Type
export type SubmissionMode = "followUp" | "steer"
export type Delivery =
  "queued" | "accepted" | "consumed" | "answered" | "unanswered"
export type Turn = ChatTurn & {
  parent_id: string | null
  mode: SubmissionMode
  delivery: Delivery
  model: string | null
  thinking: ThinkingLevel | null
  revision: number
  creation: string | null
}
export type Submission = {
  operationId: string
  text: string
  mode?: SubmissionMode
  retryOf?: string
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
