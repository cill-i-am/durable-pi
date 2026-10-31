import { Schema } from "effect"

import {
  runtimeLibraryVersion,
  nativePiVersion,
  StoredLibraryVersion,
  StoredPiVersion,
} from "../shared/runtime-versions"
import { BackgroundHandoff } from "./background"
import { backgroundRejected } from "./background-domain"
import { Control, NativeId, type Group, type TaskBrief } from "./contracts"
import { REQUEST_LIMIT } from "./delegation"
import type { ChildFacts } from "./domain"

export const LegacyBackgroundChild = Schema.Struct({
  id: NativeId,
  provider: Schema.String,
  requests: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0)
  ),
  stopped: Schema.Boolean,
})
export type LegacyBackgroundChild = typeof LegacyBackgroundChild.Type
export const LegacyBackgroundState = Schema.Struct({
  handoff: BackgroundHandoff,
  stopped: Schema.Boolean,
  sealed: Schema.Boolean,
  revision: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0)
  ),
  children: Schema.Array(LegacyBackgroundChild),
  controls: Schema.Array(Control),
  applied: Schema.Array(Schema.String),
})
export type LegacyBackgroundState = typeof LegacyBackgroundState.Type

export const BackgroundChild = Schema.Struct({
  id: NativeId,
  provider: Schema.String,
  requests: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0)
  ),
  authority: Schema.Literals(["active", "revoked"]),
  stop: Schema.Literals(["none", "pending", "confirmed", "unconfirmed"]),
  stopAttempt: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0)
  ),
})
export type BackgroundChild = typeof BackgroundChild.Type
export const BackgroundSubmission = Schema.Struct({
  child: NativeId,
  request: Schema.String,
  text: Schema.String,
  steer: Schema.Boolean,
  status: Schema.Literals(["pending", "claimed", "submitted", "unconfirmed"]),
  claim: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
})
export const BackgroundState = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  workflowVersion: Schema.Literal(1),
  libraryVersion: StoredLibraryVersion,
  piVersion: StoredPiVersion,
  handoff: BackgroundHandoff,
  outcome: Schema.Literals(["working", "completed", "cancelled"]),
  authority: Schema.Literals(["active", "revoked"]),
  revision: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0)
  ),
  children: Schema.Array(BackgroundChild),
  controls: Schema.Array(Control),
  applied: Schema.Array(Schema.String),
  submissions: Schema.Array(BackgroundSubmission),
})
export type BackgroundState = typeof BackgroundState.Type

/** Pure, explicit v1 conversion. Legacy flags never acknowledge native cleanup. */
export function migrateBackgroundState(raw: unknown): BackgroundState {
  if (
    typeof raw === "object" &&
    raw !== null &&
    ["schemaVersion", "workflowVersion", "libraryVersion", "piVersion"].some(
      (key) => key in raw
    )
  )
    return restoreBackgroundState(raw)
  const old = Schema.decodeUnknownSync(LegacyBackgroundState)(raw)
  return restoreBackgroundState({
    schemaVersion: 2,
    workflowVersion: 1,
    libraryVersion: runtimeLibraryVersion,
    piVersion: nativePiVersion,
    handoff: old.handoff,
    outcome: old.stopped ? "cancelled" : old.sealed ? "completed" : "working",
    authority: old.stopped || old.sealed ? "revoked" : "active",
    revision: old.revision,
    controls: old.controls,
    applied: old.applied,
    children: old.children.map(({ stopped, ...child }) => ({
      ...child,
      authority: stopped || old.stopped ? "revoked" : "active",
      stop: stopped || old.stopped ? "pending" : "none",
      stopAttempt: 0,
    })),
    submissions: [
      ...old.children.map((child, index) => ({
        child: child.id,
        request: backgroundInitialId(child.id),
        text: old.handoff.input.tasks[index]!.task,
        steer: false,
        status: "pending",
        claim: 0,
      })),
      ...old.controls.flatMap((control) =>
        control.action.type === "steer"
          ? [
              {
                child: control.childId,
                request: backgroundControlId(control),
                text: control.action.text,
                steer: true,
                status: "pending",
                claim: 0,
              },
            ]
          : []
      ),
    ],
  })
}
export const backgroundChildInstructions = (
  handoff: BackgroundHandoff,
  task: TaskBrief
) =>
  `You are the background drafting child ${task.name}. Work only on the supplied task and text reference. You have no tools, live retrieval, images, outside-action authority or delegation. Report uncertainty and missing evidence explicitly. Respect all constraints and later steering.\n<reference>\n${handoff.memory}\n</reference>`

export function restoreBackgroundState(raw: unknown): BackgroundState {
  const state = Schema.decodeUnknownSync(BackgroundState)(raw)
  if (
    (state.outcome === "working"
      ? state.authority !== "active"
      : state.authority !== "revoked") ||
    state.submissions.length !==
      state.children.length +
        state.controls.filter((control) => control.action.type === "steer")
          .length ||
    new Set(state.submissions.map((command) => command.request)).size !==
      state.submissions.length ||
    state.submissions.some((command) => {
      const index = state.children.findIndex(
        (child) => child.id === command.child
      )
      if (index < 0) return true
      if (!command.steer)
        return (
          command.request !== backgroundInitialId(command.child) ||
          command.text !== state.handoff.input.tasks[index]!.task
        )
      return !state.controls.some(
        (control) =>
          control.childId === command.child &&
          control.action.type === "steer" &&
          backgroundControlId(control) === command.request &&
          control.action.text === command.text
      )
    }) ||
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
    status: state.outcome,
    children: state.children.map((child, index) => {
      const fact = facts[index]!
      const stopped =
        state.outcome === "cancelled" ||
        child.authority === "revoked" ||
        (state.outcome === "working" && now >= state.handoff.deadline)
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
        status:
          child.stop === "pending" || child.stop === "unconfirmed"
            ? "stopping"
            : pending
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
          child.stop === "unconfirmed"
            ? "Native Stop remains unconfirmed. Retry Stop to reconcile cleanup."
            : failed && !pending && !stopped
              ? child.requests >= REQUEST_LIMIT
                ? "This child reached its request limit."
                : "The model did not complete this task."
              : null,
      }
    }),
  }
}
