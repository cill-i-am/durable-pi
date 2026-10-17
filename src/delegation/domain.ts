import { Schema } from "effect"

import { ResolvedRoute } from "../inference/policy"
import {
  Control,
  DelegateInput,
  DelegationFailure,
  NativeId,
  TaskBrief,
  type Group,
} from "./contracts"
import { REPORT_BYTES, REQUEST_LIMIT } from "./delegation"
import type { DelegationFacts } from "./delegations"

export const SavedGroup = Schema.Struct({
  id: NativeId,
  turnId: Schema.String,
  conversationId: NativeId,
  input: DelegateInput,
  route: ResolvedRoute,
  memory: Schema.String,
  createdAt: Schema.Number,
  deadline: Schema.Number,
  revision: Schema.Number,
  closed: Schema.Boolean,
  children: Schema.Array(
    Schema.Struct({
      ...TaskBrief.fields,
      id: NativeId,
      requests: Schema.Number,
      stopped: Schema.Boolean,
    })
  ),
  controls: Schema.Array(Control),
})
export type SavedGroup = typeof SavedGroup.Type
export const failure = (code: DelegationFailure["code"], message: string) =>
  new DelegationFailure({ code, message })
export const missing = () =>
  failure("not_found", "This delegated task is unavailable in this bot.")
export const requestId = (group: SavedGroup, child: number) =>
  `delegation:${group.id}:${child}`
export const controlId = (control: Control) =>
  `delegation-control:${control.operationId}`
export function requireCurrent(group: SavedGroup, authority: DelegationFacts) {
  if (!authority.current(group.turnId, group.conversationId) || group.closed)
    throw failure(
      "cancelled",
      "The parent request has ended. Saved tasks cannot restart it."
    )
}
export function requireChild(group: SavedGroup, childId: number, now: number) {
  const child = group.children.find((value) => value.id === childId)
  if (!child) throw missing()
  if (child.stopped || now >= group.deadline)
    throw failure("cancelled", "This child has stopped.")
  return child
}
export function acceptControl(
  group: SavedGroup,
  input: Control,
  now: number,
  authority: DelegationFacts
): SavedGroup {
  requireCurrent(group, authority)
  const child = requireChild(group, input.childId, now)
  if (
    input.action.type === "steer" &&
    group.controls.filter(
      (value) => value.childId === child.id && value.action.type === "steer"
    ).length >= 8
  )
    throw failure(
      "limit",
      "This child reached its steering limit. Continue in a new parent request."
    )
  return {
    ...group,
    revision: group.revision + 1,
    controls: [...group.controls, input],
    children: group.children.map((value) =>
      value.id === input.childId && input.action.type === "stop"
        ? { ...value, stopped: true }
        : value
    ),
  }
}
export function consumeRequest(
  group: SavedGroup,
  childId: number,
  now: number,
  authority: DelegationFacts
): SavedGroup {
  requireCurrent(group, authority)
  const child = group.children.find((value) => value.id === childId)
  if (!child || child.stopped)
    throw failure("cancelled", "This child has stopped.")
  if (now >= group.deadline || child.requests >= REQUEST_LIMIT)
    throw failure("limit", "This delegated task reached its execution limit.")
  return {
    ...group,
    revision: group.revision + 1,
    children: group.children.map((value) =>
      value.id === child.id ? { ...value, requests: value.requests + 1 } : value
    ),
  }
}
export interface ChildFacts {
  readonly inputs: readonly (
    | { readonly status: "queued" | "placed" | "done" | "unanswered" }
    | undefined
  )[]
  readonly answer: string
  readonly inputTokens: number | null
  readonly outputTokens: number | null
}
export function projectGroup(
  group: SavedGroup,
  facts: readonly ChildFacts[],
  cancelled: boolean,
  now: number
): Group {
  return {
    id: group.id,
    turnId: group.turnId,
    conversationId: group.conversationId,
    objective: group.input.objective,
    route: group.route,
    createdAt: group.createdAt,
    deadline: group.deadline,
    status: cancelled ? "cancelled" : group.closed ? "completed" : "working",
    children: group.children.map((child, index) => {
      const fact = facts[index]!
      const stopped =
        child.stopped || cancelled || (!group.closed && now >= group.deadline)
      const pending = fact.inputs.some(
        (value) =>
          (!value && !stopped) ||
          value?.status === "queued" ||
          value?.status === "placed"
      )
      const failed = fact.inputs.some(
        (value) => value?.status === "unanswered" || (!value && stopped)
      )
      return {
        id: child.id,
        name: child.name,
        task: child.task,
        tools: child.tools,
        requests: child.requests,
        answer: cut(fact.answer, 12000),
        inputTokens: fact.inputTokens,
        outputTokens: fact.outputTokens,
        steering: group.controls
          .filter(
            (value) =>
              value.childId === child.id && value.action.type === "steer"
          )
          .map((value) =>
            value.action.type === "steer" ? value.action.text : ""
          ),
        status: pending
          ? stopped
            ? "stopping"
            : fact.inputs.every((value) => !value || value.status === "queued")
              ? "queued"
              : "working"
          : failed
            ? stopped
              ? "cancelled"
              : "failed"
            : "completed",
        error:
          failed && !stopped
            ? child.requests >= REQUEST_LIMIT
              ? "This child reached its request limit."
              : "This child ended before answering all its inputs."
            : null,
      }
    }),
  }
}
export function cut(value: string, bytes: number) {
  const encoded = new TextEncoder().encode(value)
  return encoded.length <= bytes
    ? value
    : new TextDecoder().decode(encoded.slice(0, bytes), { stream: true }) +
        "\n[Shortened; inspect the child conversation for the full answer.]"
}
export const report = (group: Group) =>
  `Delegation group ${group.id}: ${group.objective}\n` +
  group.children
    .map(
      (child) =>
        `\n[Child ${child.id}: ${child.name}; ${child.status}]\n${child.error ?? ""}\n${cut(child.answer, Math.floor(REPORT_BYTES / 3) - 500)}`
    )
    .join("\n")
