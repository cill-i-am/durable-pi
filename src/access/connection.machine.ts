import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { transition, type EventFromLogic } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import { ConnectionError, SavedConnection } from "./connections"

export const ConnectionState = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  record: SavedConnection,
})
export type ConnectionState = typeof ConnectionState.Type
export const restoreConnectionState = Schema.decodeUnknownSync(ConnectionState)
const revision = SavedConnection.fields.revision
const machine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    context: ConnectionState,
    input: ConnectionState,
    events: {
      ACTIVATE: Schema.Struct({ expectedRevision: revision }),
      DISCONNECT: Schema.Struct({ expectedRevision: revision }),
    },
  },
}).createMachine({
  id: "mcp-connection-activation",
  version: "1",
  initial: "active",
  context: ({ input }) => input,
  on: {
    ACTIVATE: ({ context, event }) =>
      change(context, event.expectedRevision, true),
    DISCONNECT: ({ context, event }) =>
      change(context, event.expectedRevision, false),
  },
  states: { active: {}, inactive: {} },
})
function change(
  context: ConnectionState,
  expectedRevision: number,
  active: boolean
) {
  const current = context.record
  if (current.active === active && current.revision === expectedRevision + 1)
    return {}
  if (current.revision !== expectedRevision)
    throw new ConnectionError({
      message: "This connection changed. Reload before updating it.",
    })
  return {
    target: active ? ".active" : ".inactive",
    context: {
      ...context,
      record: { ...current, active, revision: current.revision + 1 },
    },
  }
}
/** Existing active/revision columns reconstruct version one without entry work,
 * native replay, identity replacement, or a second persisted snapshot. */
export function connectionState(record: SavedConnection): ConnectionState {
  return restoreConnectionState({
    schemaVersion: 1,
    workflowVersion: 1,
    record,
  })
}
export function advanceConnection(
  record: SavedConnection,
  event: EventFromLogic<typeof machine>
) {
  const [next, effects] = transition(
    machine,
    machine.resolveState({
      value: record.active ? "active" : "inactive",
      context: connectionState(record),
    }),
    event
  )
  if (effects.length)
    throw new Error("Connection activation emitted an unexpected effect")
  const saved = restoreConnectionState(next.context).record
  return saved.revision === record.revision ? record : saved
}
