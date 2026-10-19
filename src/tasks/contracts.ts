import { Schema } from "effect"

import { AgentId } from "../agents/domain"

export const TaskKind = Schema.Literals(["request", "bot-task", "background"])
export const TaskReference = Schema.Struct({
  kind: TaskKind,
  id: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(180),
    Schema.isPattern(/^[a-zA-Z0-9:_-]+$/)
  ),
})
export type TaskReference = typeof TaskReference.Type
export const Task = Schema.Struct({
  ...TaskReference.fields,
  title: Schema.String,
  state: Schema.String,
  terminal: Schema.Boolean,
})
export type Task = typeof Task.Type
export const TaskList = Schema.Array(Task)
export class TaskControlError extends Schema.TaggedError<TaskControlError>()(
  "TaskControlError",
  {
    code: Schema.Literals(["invalid", "not_found", "unavailable"]),
    message: Schema.String,
  }
) {}
export const taskError = (code: TaskControlError["code"], message: string) =>
  new TaskControlError({ code, message })

export function taskHandle(agent: AgentId, task: TaskReference) {
  return `${agent}/${task.kind}/${task.id}`
}
export function parseTaskHandle(handle: string): {
  agent: AgentId
  task: TaskReference
} {
  const [agent, kind, id, extra] = handle.split("/")
  const a = Schema.decodeUnknownOption(AgentId)(agent)
  const t = Schema.decodeUnknownOption(TaskReference)({ kind, id })
  if (
    extra !== undefined ||
    a._tag === "None" ||
    t._tag === "None" ||
    (kind === "background" && !/^[1-9][0-9]*$/.test(id!))
  )
    throw taskError(
      "invalid",
      "Copy the exact task handle from STATUS before stopping work."
    )
  return { agent: a.value, task: t.value }
}
