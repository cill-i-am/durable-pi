import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { transition, type EventFromLogic } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import { DelegationFailure } from "./contracts"
import type { SavedGroup } from "./domain"

export const GroupLifecycle = Schema.Literals(["open", "closing", "closed"])
export const ChildLifecycle = Schema.Literals([
  "active",
  "stopping",
  "unconfirmed",
  "stopped",
])
const Context = Schema.Struct({
  detached: Schema.Boolean,
  allStopped: Schema.Boolean,
  cleanupPending: Schema.Boolean,
})
const GroupEvents = {
  REVOKE: Schema.Struct({}),
  SETTLED: Schema.Struct({}),
  CLEANED: Schema.Struct({}),
}
export const delegationGroupMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: Context,
    context: Context,
    events: GroupEvents,
  },
}).createMachine({
  id: "local-delegation-group",
  version: "1",
  initial: "open",
  context: ({ input }) => input,
  states: {
    open: {
      on: {
        REVOKE: { target: "closing" },
        SETTLED: ({ context }) =>
          !context.detached && !context.cleanupPending
            ? { target: "closed" }
            : undefined,
        CLEANED: ({ context }) =>
          context.allStopped
            ? { target: context.cleanupPending ? "closing" : "closed" }
            : undefined,
      },
    },
    closing: {
      on: {
        CLEANED: ({ context }) =>
          context.allStopped && !context.cleanupPending
            ? { target: "closed" }
            : undefined,
      },
    },
    closed: {},
  },
})
const ChildContext = Schema.Struct({
  requests: Schema.Number,
  steers: Schema.Number,
})
const ChildEvents = {
  REQUEST: Schema.Struct({ authorized: Schema.Boolean }),
  STEER: Schema.Struct({ authorized: Schema.Boolean }),
  STOP: Schema.Struct({}),
  CONFIRMED: Schema.Struct({}),
  UNCERTAIN: Schema.Struct({}),
}
export const delegationChildMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: ChildContext,
    context: ChildContext,
    events: ChildEvents,
  },
}).createMachine({
  id: "local-delegation-child",
  version: "1",
  initial: "active",
  context: ({ input }) => input,
  states: {
    active: {
      on: {
        REQUEST: ({ context, event }) => {
          if (!event.authorized || context.requests >= 12)
            throw new DelegationFailure({
              code: "limit",
              message: "This delegated task reached its execution limit.",
            })
          return { context: { ...context, requests: context.requests + 1 } }
        },
        STEER: ({ context, event }) => {
          if (!event.authorized || context.steers >= 8)
            throw new DelegationFailure({
              code: "limit",
              message:
                "This child reached its steering limit. Continue in a new parent request.",
            })
          return { context: { ...context, steers: context.steers + 1 } }
        },
        STOP: { target: "stopping" },
      },
    },
    stopping: {
      on: {
        CONFIRMED: { target: "stopped" },
        UNCERTAIN: { target: "unconfirmed" },
      },
    },
    unconfirmed: {
      on: { STOP: { target: "stopping" }, CONFIRMED: { target: "stopped" } },
    },
    stopped: {},
  },
})
export function advanceChild(
  group: SavedGroup,
  childId: number,
  event: EventFromLogic<typeof delegationChildMachine>
): SavedGroup {
  if (!event || !Object.hasOwn(ChildEvents, event.type))
    throw new Error("Invalid child lifecycle event")
  Schema.decodeUnknownSync(
    Schema.Struct({
      type: Schema.Literal(event.type),
      ...ChildEvents[event.type].fields,
    }),
    { onExcessProperty: "error" }
  )(event)
  const child = group.children.find((value) => value.id === childId)
  if (!child)
    throw new DelegationFailure({
      code: "not_found",
      message: "This delegated task is unavailable in this bot.",
    })
  const [next, effects] = transition(
    delegationChildMachine,
    delegationChildMachine.resolveState({
      value: child.lifecycle ?? (child.stopped ? "stopping" : "active"),
      context: {
        requests: child.requests,
        steers: group.controls.filter(
          (control) =>
            control.childId === childId && control.action.type === "steer"
        ).length,
      },
    }),
    event
  )
  if (effects.length) throw new Error("Unexpected child lifecycle effect")
  if (
    next.value === child.lifecycle &&
    next.context.requests === child.requests &&
    event.type !== "STEER"
  )
    return group
  return {
    ...group,
    revision: group.revision + 1,
    children: group.children.map((value) =>
      value.id === childId
        ? {
            ...value,
            requests: next.context.requests,
            lifecycle: next.value,
            stopped: next.value !== "active",
          }
        : value
    ),
  }
}
export function advanceGroup(
  group: SavedGroup,
  event: EventFromLogic<typeof delegationGroupMachine>
): SavedGroup {
  if (!event || !Object.hasOwn(GroupEvents, event.type))
    throw new Error("Invalid group lifecycle event")
  Schema.decodeUnknownSync(
    Schema.Struct({
      type: Schema.Literal(event.type),
      ...GroupEvents[event.type].fields,
    }),
    { onExcessProperty: "error" }
  )(event)
  const [next, effects] = transition(
    delegationGroupMachine,
    delegationGroupMachine.resolveState({
      value: group.lifecycle ?? (group.closed ? "closed" : "open"),
      context: {
        detached: !!group.detached,
        allStopped: group.children.every((child) => child.stopped),
        cleanupPending: group.children.some(
          (child) => child.stopped && child.lifecycle !== "stopped"
        ),
      },
    }),
    event
  )
  if (effects.length) throw new Error("Unexpected group lifecycle effect")
  if (next.value === group.lifecycle) return group
  return {
    ...group,
    revision: group.revision + 1,
    lifecycle: next.value,
    closed: next.value === "closed",
  }
}
