import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { Approval } from "@/access/contracts"

/** A presentation identity includes the complete request and its approval round.
 * Reviewing or deferring an older round never applies to replacement inputs. */
export const decisionKey = (approval: Approval) =>
  JSON.stringify([
    approval.id,
    approval.turnId,
    approval.tool,
    approval.input,
    approval.createdAt,
    approval.expiresAt,
    approval.revision,
  ])

export const DecisionDockView = Schema.Struct({
  agentId: Schema.String,
  approvals: Schema.Array(Approval),
})
export type DecisionDockView = typeof DecisionDockView.Type
const keyEvent = Schema.Struct({ key: Schema.String })
const context = Schema.Struct({
  view: DecisionDockView,
  selected: Schema.NullOr(Schema.String),
  deferred: Schema.Array(Schema.String),
  acknowledged: Schema.Array(Schema.String),
  locked: Schema.Boolean,
  returnToQueue: Schema.Boolean,
  notice: Schema.String,
})
type DockContext = typeof context.Type

export const pendingDecisions = (value: DockContext) =>
  value.view.approvals.filter(
    (approval) =>
      approval.status === "pending" &&
      !value.acknowledged.includes(decisionKey(approval))
  )

function nextSelection(value: DockContext) {
  return (
    pendingDecisions(value)
      .map(decisionKey)
      .find((key) => !value.deferred.includes(key)) ?? null
  )
}
function available(value: DockContext, key: string) {
  return pendingDecisions(value).some((item) => decisionKey(item) === key)
}

/** Local presentation only. Access and the existing approval machine own all
 * authorization, command identity, acknowledgements and external uncertainty. */
export const decisionDockMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: DecisionDockView,
    context,
    events: {
      VIEW: DecisionDockView,
      QUEUE: Schema.Struct({}),
      SELECT: keyEvent,
      REVIEW: Schema.Struct({ key: Schema.String, fromQueue: Schema.Boolean }),
      CLOSE: Schema.Struct({}),
      DEFER: keyEvent,
      LOCK: Schema.Struct({ key: Schema.String, locked: Schema.Boolean }),
      ACKNOWLEDGED: Schema.Struct({
        key: Schema.String,
        approve: Schema.Boolean,
      }),
    },
  },
}).createMachine({
  id: "decision-dock",
  initial: "compact",
  context: ({ input }) => {
    const initial = {
      view: input,
      selected: null,
      deferred: [],
      acknowledged: [],
      locked: false,
      returnToQueue: false,
      notice: "",
    }
    return { ...initial, selected: nextSelection(initial) }
  },
  on: {
    VIEW: ({ context, event }) => {
      const view = Schema.decodeUnknownSync(DecisionDockView)(event)
      const keys = view.approvals
        .filter((item) => item.status === "pending")
        .map(decisionKey)
      const sameAgent = view.agentId === context.view.agentId
      const updated = {
        ...context,
        view,
        deferred: sameAgent
          ? context.deferred.filter((key) => keys.includes(key))
          : [],
        acknowledged: sameAgent
          ? context.acknowledged.filter((key) => keys.includes(key))
          : [],
      }
      const selected =
        sameAgent && context.selected && available(updated, context.selected)
          ? context.selected
          : nextSelection(updated)
      return {
        ...(selected !== context.selected ? { target: ".compact" } : {}),
        context: {
          ...updated,
          selected,
          locked: selected === context.selected && sameAgent && context.locked,
          notice:
            sameAgent &&
            !context.acknowledged.some((key) => !keys.includes(key))
              ? context.notice
              : "",
        },
      }
    },
    SELECT: ({ context, event }) =>
      !context.locked && available(context, event.key)
        ? {
            target: ".queue",
            context: {
              ...context,
              selected: event.key,
              deferred: context.deferred.filter((key) => key !== event.key),
              notice: "",
            },
          }
        : undefined,
    REVIEW: ({ context, event }) =>
      context.selected === event.key && available(context, event.key)
        ? {
            target: ".review",
            context: { ...context, returnToQueue: event.fromQueue },
          }
        : undefined,
    DEFER: ({ context, event }) => {
      if (context.locked || context.selected !== event.key) return
      const updated = {
        ...context,
        deferred: [...context.deferred, event.key],
        notice: "Deferred for now. Still awaiting approval.",
      }
      return {
        target: ".compact",
        context: { ...updated, selected: nextSelection(updated) },
      }
    },
    LOCK: ({ context, event }) =>
      context.selected === event.key
        ? { context: { ...context, locked: event.locked } }
        : undefined,
    ACKNOWLEDGED: ({ context, event }) => {
      if (context.selected !== event.key) return
      const updated = {
        ...context,
        locked: false,
        acknowledged: [...context.acknowledged, event.key],
        notice: event.approve
          ? "Approval accepted. Waiting for action status."
          : "Action declined.",
      }
      return {
        target: ".compact",
        context: { ...updated, selected: nextSelection(updated) },
      }
    },
  },
  states: {
    compact: { on: { QUEUE: { target: "queue" } } },
    queue: { on: { QUEUE: { target: "compact" } } },
    review: {
      on: {
        CLOSE: ({ context }) => ({
          target: context.returnToQueue ? "queue" : "compact",
        }),
      },
    },
  },
})
