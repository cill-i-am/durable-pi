import { Schema } from "effect"
import { ResolvedRoute } from "../inference/policy"

const text = (max: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max))
export const NativeId = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0)
)
export const ReadTool = Schema.Literals([
  "zoom",
  "date",
  "search_memory",
  "list_files",
  "read_file",
  "read_note",
])
export type ReadTool = typeof ReadTool.Type
export const TaskBrief = Schema.Struct({
  name: text(80),
  task: text(8000),
  tools: Schema.Array(ReadTool).check(Schema.isMaxLength(6)),
})
export type TaskBrief = typeof TaskBrief.Type
export const DelegateInput = Schema.Struct({
  objective: text(500),
  tasks: Schema.Array(TaskBrief).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(3)
  ),
})
export type DelegateInput = typeof DelegateInput.Type
export const ChildStatus = Schema.Literals([
  "queued",
  "working",
  "stopping",
  "completed",
  "failed",
  "cancelled",
])
export const Child = Schema.Struct({
  ...TaskBrief.fields,
  id: NativeId,
  status: ChildStatus,
  answer: Schema.String,
  requests: Schema.Number,
  inputTokens: Schema.NullOr(Schema.Number),
  outputTokens: Schema.NullOr(Schema.Number),
  steering: Schema.Array(Schema.String),
  error: Schema.NullOr(Schema.String),
})
export type Child = typeof Child.Type
export const Group = Schema.Struct({
  id: NativeId,
  turnId: Schema.String,
  conversationId: NativeId,
  objective: Schema.String,
  route: ResolvedRoute,
  createdAt: Schema.Number,
  deadline: Schema.Number,
  status: Schema.Literals(["working", "completed", "cancelled"]),
  children: Schema.Array(Child),
})
export type Group = typeof Group.Type
export const Control = Schema.Struct({
  groupId: NativeId,
  childId: NativeId,
  operationId: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/i)),
  action: Schema.Union([
    Schema.Struct({ type: Schema.Literal("stop") }),
    Schema.Struct({ type: Schema.Literal("steer"), text: text(8000) }),
  ]),
})
export type Control = typeof Control.Type
export class DelegationFailure extends Schema.TaggedError<DelegationFailure>()(
  "DelegationFailure",
  {
    code: Schema.Literals([
      "invalid",
      "not_found",
      "cancelled",
      "conflict",
      "limit",
      "unavailable",
    ]),
    message: Schema.String,
  }
) {}
export const Transcript = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({ id: NativeId, kind: Schema.String, text: Schema.String })
  ),
  cursor: Schema.NullOr(Schema.String),
})
export type Transcript = typeof Transcript.Type
