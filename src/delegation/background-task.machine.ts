import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { initialTransition, transition, type EventFromLogic } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import {
  runtimeLibraryVersion,
  nativePiVersion,
} from "../shared/runtime-versions"
import { backgroundRejected } from "./background-domain"
import {
  BackgroundState,
  backgroundChild,
  backgroundControlId,
  backgroundInitialId,
  restoreBackgroundState,
} from "./background-task-domain"
import { Control } from "./contracts"
import { REQUEST_LIMIT } from "./delegation"

const { outcome: _, ...fields } = BackgroundState.fields
const Context = Schema.Struct(fields)
type Data = typeof Context.Type
const changed = (state: Data): Data => ({
  ...state,
  revision: state.revision + 1,
})
const revoke = (context: Data, cancelChildren = true): Data => ({
  ...changed(context),
  authority: "revoked",
  children: context.children.map((child) => ({
    ...child,
    authority: cancelChildren ? "revoked" : child.authority,
    stop: child.stop === "confirmed" ? "confirmed" : "pending",
  })),
})
export const backgroundTaskMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    context: Context,
    input: Context,
    events: {
      REVOKE: Schema.Struct({}),
      CONTROL: Schema.Struct({ input: Control, now: Schema.Number }),
      REQUEST: Schema.Struct({ provider: Schema.String, now: Schema.Number }),
      CLAIM: Schema.Struct({
        request: Schema.String,
        now: Schema.Number,
        authorized: Schema.Boolean,
      }),
      SUBMITTED: Schema.Struct({
        request: Schema.String,
        claim: Schema.Number,
      }),
      UNCONFIRMED: Schema.Struct({
        request: Schema.String,
        claim: Schema.Number,
      }),
      STOP_CLAIM: Schema.Struct({ child: Schema.Number }),
      STOP_ACK: Schema.Struct({ child: Schema.Number, attempt: Schema.Number }),
      STOP_FAILED: Schema.Struct({
        child: Schema.Number,
        attempt: Schema.Number,
      }),
      OBSERVED: Schema.Struct({
        revision: Schema.Number,
        settled: Schema.Boolean,
        now: Schema.Number,
      }),
    },
  },
}).createMachine({
  id: "remote-background-task",
  version: "1",
  initial: "working",
  context: ({ input }) => input,
  on: {
    CONTROL: ({ context, event }) => {
      const input = event.input
      if (input.groupId !== context.handoff.id)
        throw backgroundRejected(
          "not_found",
          "Child unavailable in this group."
        )
      const child = backgroundChild(
        { ...context, outcome: "working" },
        input.childId
      )
      const prior = context.controls.find(
        (value) => value.operationId === input.operationId
      )
      if (prior) {
        if (JSON.stringify(prior) !== JSON.stringify(input))
          throw backgroundRejected(
            "conflict",
            "This control ID belongs to another operation."
          )
        return
      }
      if (
        context.authority === "revoked" ||
        child.authority === "revoked" ||
        event.now >= context.handoff.deadline
      )
        throw backgroundRejected(
          "cancelled",
          "This background group has finished or stopped."
        )
      if (
        input.action.type === "steer" &&
        context.controls.filter(
          (value) =>
            value.childId === input.childId && value.action.type === "steer"
        ).length >= 8
      )
        throw backgroundRejected(
          "limit",
          "This child reached its steering limit."
        )
      return {
        context: {
          ...changed(context),
          controls: [...context.controls, input],
          children: context.children.map((value) =>
            value.id === input.childId && input.action.type === "stop"
              ? {
                  ...value,
                  authority: "revoked" as const,
                  stop: "pending" as const,
                }
              : value
          ),
          submissions:
            input.action.type === "steer"
              ? [
                  ...context.submissions,
                  {
                    child: input.childId,
                    request: backgroundControlId(input),
                    text: input.action.text,
                    steer: true,
                    status: "pending" as const,
                    claim: 0,
                  },
                ]
              : context.submissions,
        },
      }
    },
    REQUEST: ({ context, event }) => {
      const child = context.children.find(
        (value) => value.provider === event.provider
      )
      if (
        !child ||
        child.authority === "revoked" ||
        context.authority === "revoked"
      )
        throw backgroundRejected(
          "cancelled",
          "This background task has stopped."
        )
      if (
        event.now >= context.handoff.deadline ||
        child.requests >= REQUEST_LIMIT
      )
        throw backgroundRejected(
          "limit",
          "This background task reached its execution limit."
        )
      return {
        context: {
          ...changed(context),
          children: context.children.map((value) =>
            value.id === child.id
              ? { ...value, requests: value.requests + 1 }
              : value
          ),
        },
      }
    },
    CLAIM: ({ context, event }) => {
      const command = context.submissions.find(
        (value) => value.request === event.request
      )
      if (!command || command.status === "submitted") return
      const child = context.children.find(
        (value) => value.id === command.child
      )!
      if (
        !event.authorized ||
        context.authority === "revoked" ||
        child.authority === "revoked" ||
        event.now >= context.handoff.deadline
      )
        return
      return {
        context: {
          ...changed(context),
          submissions: context.submissions.map((value) =>
            value.request === command.request
              ? {
                  ...value,
                  status: "claimed" as const,
                  claim: context.revision + 1,
                }
              : value
          ),
        },
      }
    },
    SUBMITTED: ({ context, event }) => {
      const command = context.submissions.find(
        (value) =>
          value.request === event.request &&
          value.claim === event.claim &&
          value.status === "claimed"
      )
      if (!command) return
      return {
        context: {
          ...changed(context),
          submissions: context.submissions.map((value) =>
            value === command
              ? { ...value, status: "submitted" as const }
              : value
          ),
          applied: [
            ...new Set([
              ...context.applied,
              ...context.controls
                .filter(
                  (value) =>
                    value.action.type === "steer" &&
                    backgroundControlId(value) === command.request
                )
                .map((value) => value.operationId),
            ]),
          ],
        },
      }
    },
    UNCONFIRMED: ({ context, event }) => {
      if (
        !context.submissions.some(
          (value) =>
            value.request === event.request &&
            value.claim === event.claim &&
            value.status === "claimed"
        )
      )
        return
      return {
        context: {
          ...changed(context),
          submissions: context.submissions.map((value) =>
            value.request === event.request
              ? { ...value, status: "unconfirmed" as const }
              : value
          ),
        },
      }
    },
    STOP_CLAIM: ({ context, event }) => {
      if (
        !context.children.some(
          (child) =>
            child.id === event.child &&
            (child.stop === "pending" || child.stop === "unconfirmed")
        )
      )
        return
      return {
        context: {
          ...changed(context),
          children: context.children.map((child) =>
            child.id === event.child
              ? {
                  ...child,
                  stop: "pending" as const,
                  stopAttempt: child.stopAttempt + 1,
                }
              : child
          ),
        },
      }
    },
    STOP_ACK: ({ context, event }) => {
      if (
        event.attempt < 1 ||
        !context.children.some(
          (child) =>
            child.id === event.child &&
            child.stopAttempt === event.attempt &&
            child.stop === "pending"
        )
      )
        return
      return {
        context: {
          ...changed(context),
          children: context.children.map((child) =>
            child.id === event.child
              ? { ...child, stop: "confirmed" as const }
              : child
          ),
          applied: [
            ...new Set([
              ...context.applied,
              ...context.controls
                .filter(
                  (value) =>
                    value.childId === event.child &&
                    value.action.type === "stop"
                )
                .map((value) => value.operationId),
            ]),
          ],
        },
      }
    },
    STOP_FAILED: ({ context, event }) => {
      if (
        event.attempt < 1 ||
        !context.children.some(
          (child) =>
            child.id === event.child &&
            child.stopAttempt === event.attempt &&
            child.stop === "pending"
        )
      )
        return
      return {
        context: {
          ...changed(context),
          children: context.children.map((child) =>
            child.id === event.child
              ? { ...child, stop: "unconfirmed" as const }
              : child
          ),
        },
      }
    },
  },
  states: {
    working: {
      on: {
        REVOKE: ({ context }) => ({
          target: "cancelled",
          context: revoke(context),
        }),
        OBSERVED: ({ context, event }) => {
          if (event.revision !== context.revision) return
          if (event.now >= context.handoff.deadline)
            return { target: "cancelled", context: revoke(context) }
          if (event.settled)
            return {
              target: "completed",
              context: { ...changed(context), authority: "revoked" },
            }
        },
      },
    },
    completed: {
      on: { REVOKE: ({ context }) => ({ context: revoke(context, false) }) },
    },
    cancelled: {
      on: { REVOKE: ({ context }) => ({ context: revoke(context) }) },
    },
  },
})
export type BackgroundTaskEvent = EventFromLogic<typeof backgroundTaskMachine>
export function advanceBackgroundTask(
  raw: BackgroundState,
  event: BackgroundTaskEvent
): BackgroundState {
  const row = restoreBackgroundState(raw)
  const { outcome, ...context } = row
  const [next, effects] = transition(
    backgroundTaskMachine,
    backgroundTaskMachine.resolveState({ value: outcome, context }),
    event
  )
  if (effects.length)
    throw new Error(`Unsupported remote child effect: ${effects[0]!.type}`)
  const result = restoreBackgroundState({
    ...next.context,
    outcome: next.value,
  })
  return JSON.stringify(result) === JSON.stringify(row) ? raw : result
}
export function initializeBackgroundTask(
  handoff: BackgroundState["handoff"],
  children: ReadonlyArray<
    Pick<BackgroundState["children"][number], "id" | "provider">
  >
): BackgroundState {
  const input: Data = {
    schemaVersion: 2,
    workflowVersion: 1,
    libraryVersion: runtimeLibraryVersion,
    piVersion: nativePiVersion,
    handoff,
    authority: "active",
    revision: 0,
    controls: [],
    applied: [],
    children: children.map((child) => ({
      ...child,
      requests: 0,
      authority: "active",
      stop: "none",
      stopAttempt: 0,
    })),
    submissions: children.map((child, index) => ({
      child: child.id,
      request: backgroundInitialId(child.id),
      text: handoff.input.tasks[index]!.task,
      steer: false,
      status: "pending",
      claim: 0,
    })),
  }
  const [state, effects] = initialTransition(backgroundTaskMachine, input)
  if (effects.length)
    throw new Error("Unexpected background initialization effect")
  return restoreBackgroundState({ ...state.context, outcome: state.value })
}
