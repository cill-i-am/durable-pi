import { Schema } from "effect"
import { BackgroundHandoff } from "./background"
import { Control, NativeId, type Group, type TaskBrief } from "./contracts"
import { backgroundRejected } from "./background-domain"
import type { ChildFacts } from "./domain"
import { REQUEST_LIMIT } from "./delegation"

export const BackgroundChild = Schema.Struct({
  id: NativeId,
  provider: Schema.String,
  requests: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0)
  ),
  stopped: Schema.Boolean,
})
export type BackgroundChild = typeof BackgroundChild.Type
export const BackgroundState = Schema.Struct({
  handoff: BackgroundHandoff,
  stopped: Schema.Boolean,
  sealed: Schema.Boolean,
  revision: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0)
  ),
  children: Schema.Array(BackgroundChild),
  controls: Schema.Array(Control),
  applied: Schema.Array(Schema.String),
})
export type BackgroundState = typeof BackgroundState.Type

export const backgroundChildInstructions = (
  handoff: BackgroundHandoff,
  task: TaskBrief
) =>
  `You are the background drafting child ${task.name}. Work only on the supplied task and text reference. You have no tools, live retrieval, images, outside-action authority or delegation. Report uncertainty and missing evidence explicitly. Respect all constraints and later steering.\n<reference>\n${handoff.memory}\n</reference>`

export function restoreBackgroundState(raw: unknown): BackgroundState {
  const state = Schema.decodeUnknownSync(BackgroundState)(raw)
  if (
    state.children.length !== state.handoff.input.tasks.length ||
    new Set(state.children.map((child) => child.id)).size !==
      state.children.length ||
    new Set(state.children.map((child) => child.provider)).size !==
      state.children.length ||
    state.handoff.input.tasks.some((task) => task.tools.length) ||
    state.controls.some(
      (control) =>
        control.groupId !== state.handoff.id ||
        !state.children.some((child) => child.id === control.childId)
    ) ||
    new Set(state.controls.map((control) => control.operationId)).size !==
      state.controls.length ||
    state.applied.some(
      (id) => !state.controls.some((control) => control.operationId === id)
    )
  )
    throw new Error(
      "Stored background state has inconsistent child or control identities."
    )
  return state
}
export const backgroundInitialId = (child: number) =>
  `background-initial:${child}`
export const backgroundControlId = (input: Control) =>
  `background-control:${input.operationId}`
export const requireBackgroundState = (
  state: BackgroundState | null | undefined
) => {
  if (!state)
    throw backgroundRejected(
      "not_found",
      "This background group is unavailable."
    )
  return state
}
export const backgroundChild = (state: BackgroundState, id: number) => {
  const child = state.children.find((value) => value.id === id)
  if (!child)
    throw backgroundRejected("not_found", "Child unavailable in this group.")
  return child
}
export function acceptBackgroundControl(
  state: BackgroundState,
  input: Control,
  now: number
): BackgroundState {
  if (input.groupId !== state.handoff.id)
    throw backgroundRejected("not_found", "Child unavailable in this group.")
  const child = backgroundChild(state, input.childId)
  const prior = state.controls.find(
    (value) => value.operationId === input.operationId
  )
  if (prior) {
    if (JSON.stringify(prior) !== JSON.stringify(input))
      throw backgroundRejected(
        "conflict",
        "This control ID belongs to another operation."
      )
    return state
  }
  if (
    state.sealed ||
    state.stopped ||
    now >= state.handoff.deadline ||
    child.stopped
  )
    throw backgroundRejected(
      "cancelled",
      "This background group has finished or stopped."
    )
  if (
    input.action.type === "steer" &&
    state.controls.filter(
      (value) =>
        value.childId === input.childId && value.action.type === "steer"
    ).length >= 8
  )
    throw backgroundRejected("limit", "This child reached its steering limit.")
  return {
    ...state,
    revision: state.revision + 1,
    controls: [...state.controls, input],
    children: state.children.map((value) =>
      value.id === input.childId && input.action.type === "stop"
        ? { ...value, stopped: true }
        : value
    ),
  }
}
export function consumeBackgroundRequest(
  state: BackgroundState,
  provider: string,
  now: number
): BackgroundState {
  const child = state.children.find((value) => value.provider === provider)
  if (!child || child.stopped || state.stopped || state.sealed)
    throw backgroundRejected("cancelled", "This background task has stopped.")
  if (now >= state.handoff.deadline || child.requests >= REQUEST_LIMIT)
    throw backgroundRejected(
      "limit",
      "This background task reached its execution limit."
    )
  return {
    ...state,
    revision: state.revision + 1,
    children: state.children.map((value) =>
      value.id === child.id ? { ...value, requests: value.requests + 1 } : value
    ),
  }
}
export const stopBackgroundState = (state: BackgroundState): BackgroundState =>
  state.sealed
    ? state
    : { ...state, stopped: true, revision: state.revision + 1 }
export function trimBackgroundText(value: string, limit = 12000) {
  const bytes = new TextEncoder().encode(value)
  return bytes.length <= limit
    ? value
    : new TextDecoder().decode(bytes.slice(0, limit), { stream: true }) +
        "\n[Shortened; full answer is in the native transcript.]"
}
export function projectBackgroundTasks(
  state: BackgroundState,
  facts: readonly ChildFacts[],
  now: number
): Group {
  return {
    id: state.handoff.id,
    turnId: state.handoff.turnId,
    conversationId: state.handoff.conversationId,
    objective: state.handoff.input.objective,
    route: state.handoff.route,
    createdAt: state.handoff.createdAt,
    deadline: state.handoff.deadline,
    status: state.stopped
      ? "cancelled"
      : state.sealed
        ? "completed"
        : "working",
    children: state.children.map((child, index) => {
      const fact = facts[index]!
      const stopped =
        state.stopped ||
        child.stopped ||
        (!state.sealed && now >= state.handoff.deadline)
      const pending = fact.inputs.some(
        (value) =>
          value?.status === "queued" ||
          value?.status === "placed" ||
          (!value && !stopped)
      )
      const failed = fact.inputs.some(
        (value) => !value || value.status === "unanswered"
      )
      return {
        ...state.handoff.input.tasks[index]!,
        id: child.id,
        status: pending
          ? stopped
            ? "stopping"
            : "working"
          : stopped
            ? "cancelled"
            : failed
              ? "failed"
              : "completed",
        answer: trimBackgroundText(fact.answer),
        requests: child.requests,
        inputTokens: fact.inputTokens,
        outputTokens: fact.outputTokens,
        steering: state.controls
          .filter(
            (control) =>
              control.childId === child.id && control.action.type === "steer"
          )
          .map((control) =>
            control.action.type === "steer" ? control.action.text : ""
          ),
        error:
          failed && !pending && !stopped
            ? child.requests >= REQUEST_LIMIT
              ? "This child reached its request limit."
              : "The model did not complete this task."
            : null,
      }
    }),
  }
}
