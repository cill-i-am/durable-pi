import { Schema } from "effect"

import { ResolvedRoute } from "../inference/policy"
import { attributedText } from "../messages/identity"
import { ChildDispatch } from "./child-dispatch.machine"
import {
  Control,
  DelegateInput,
  DelegationFailure,
  NativeId,
  TaskBrief,
  type Group,
} from "./contracts"
import { REPORT_BYTES } from "./delegation"
import type { DelegationFacts } from "./delegations"
import { advanceChild, ChildLifecycle, GroupLifecycle } from "./group.machine"

export const SavedGroup = Schema.Struct({
  schemaVersion: Schema.optional(Schema.Literal(1)),
  workflowVersion: Schema.optional(Schema.Literal(1)),
  lifecycle: Schema.optional(GroupLifecycle),
  dispatches: Schema.optional(Schema.Array(ChildDispatch)),
  botId: Schema.optional(Schema.String),
  detached: Schema.optional(Schema.Boolean),
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
      lifecycle: Schema.optional(ChildLifecycle),
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
export const initialMessage = (
  group: SavedGroup,
  child: SavedGroup["children"][number]
) =>
  attributedText(
    child.task,
    group.botId
      ? {
          author: {
            kind: "agent",
            id: group.botId,
            sessionId: group.turnId,
            runId: group.turnId,
          },
          recipients: [
            {
              kind: "agent",
              id: `${group.botId}/child/${child.id}`,
              sessionId: group.turnId,
            },
          ],
          conversationId: group.botId,
          causedBy: String(group.id),
        }
      : undefined
  )
export function requireCurrent(group: SavedGroup, authority: DelegationFacts) {
  if (
    (group.detached
      ? authority.cancelled(group.turnId)
      : !authority.current(group.turnId, group.conversationId)) ||
    group.closed
  )
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
  if (input.action.type === "steer") {
    requireCurrent(group, authority)
    requireChild(group, input.childId, now)
  } else if (!group.children.some((child) => child.id === input.childId))
    throw missing()
  if (input.action.type === "stop" && group.closed)
    return {
      ...group,
      controls: [...group.controls, input],
      revision: group.revision + 1,
    }
  const next = advanceChild(
    group,
    input.childId,
    input.action.type === "stop"
      ? { type: "STOP" }
      : { type: "STEER", authorized: now < group.deadline }
  )
  return { ...next, controls: [...next.controls, input] }
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
  return advanceChild(group, childId, {
    type: "REQUEST",
    authorized: now < group.deadline,
  })
}

/** Version zero is the original Pi document JSON. Conversion retains every ID,
 * immutable brief and native request key, and conservatively reopens cleanup
 * for old Stop flags whose dispatch settlement was never durably represented. */
export function restoreGroup(value: SavedGroup): SavedGroup {
  if (value.schemaVersion === 1) {
    if (
      value.workflowVersion !== 1 ||
      value.lifecycle === undefined ||
      value.dispatches === undefined ||
      value.children.some((child) => child.lifecycle === undefined)
    )
      throw new Error(
        "Incomplete delegation lifecycle version; restore the original record before retrying."
      )
    if (
      value.closed !== (value.lifecycle === "closed") ||
      value.children.some(
        (child) => child.stopped !== (child.lifecycle !== "active")
      )
    )
      throw new Error(
        "Delegation lifecycle projection conflicts with its authoritative state."
      )
    return value
  }
  const cleanup = value.children.some((child) => child.stopped)
  return {
    ...value,
    schemaVersion: 1,
    workflowVersion: 1,
    lifecycle:
      cleanup && value.closed ? "closing" : value.closed ? "closed" : "open",
    closed: value.closed && !cleanup,
    children: value.children.map((child) => ({
      ...child,
      lifecycle: child.stopped ? "stopping" : "active",
    })),
    dispatches: [
      ...value.children.map((child): ChildDispatch => ({
        request: requestId(value, child.id),
        childId: child.id,
        text: initialMessage(value, child),
        steer: false,
        state: "accepted",
      })),
      ...value.controls.flatMap((control): ChildDispatch[] =>
        control.action.type === "steer"
          ? [
              {
                request: controlId(control),
                childId: control.childId,
                text: attributedText(control.action.text, control.provenance),
                steer: true,
                state: "accepted",
              },
            ]
          : []
      ),
    ],
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
    ...(group.detached ? { detached: true } : {}),
    id: group.id,
    turnId: group.turnId,
    conversationId: group.conversationId,
    objective: group.input.objective,
    route: group.route,
    createdAt: group.createdAt,
    deadline: group.deadline,
    status:
      cancelled ||
      (group.detached && group.children.every((child) => child.stopped))
        ? "cancelled"
        : group.closed
          ? "completed"
          : "working",
    children: group.children.map((child, index) => {
      const fact = facts[index]!
      const stopped =
        child.stopped || cancelled || (!group.closed && now >= group.deadline)
      const pending =
        (child.stopped &&
          child.lifecycle !== undefined &&
          child.lifecycle !== "stopped") ||
        fact.inputs.some(
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
          : stopped
            ? "cancelled"
            : failed
              ? "failed"
              : "completed",
        error:
          child.lifecycle === "unconfirmed"
            ? "Stop could not be confirmed. Retry the original Stop operation."
            : failed && !stopped
              ? child.requests >= 12
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
