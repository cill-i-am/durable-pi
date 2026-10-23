import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import {
  initialTransition,
  transition,
  type EventFromLogic,
  type ExecutableEffect,
} from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import {
  AgentConflict,
  AgentProfile,
  homeAgentId,
  requireAgentCapacity,
} from "./domain"

/** Existing catalog data is the only durable representation. */
export const AgentRecord = Schema.Struct({
  ...AgentProfile.fields,
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  creation: Schema.String,
})
export type AgentRecord = typeof AgentRecord.Type
const { status: _, ...fields } = AgentRecord.fields
const Context = Schema.toType(Schema.Struct(fields))
const counter = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const now = { now: Schema.String }
const bump = (context: typeof Context.Type, at: string) => ({
  ...context,
  revision: context.revision + 1,
  updatedAt: at,
})

export const agentProfileMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: Context,
    context: Context,
    events: {
      CREATE: Schema.Struct({ creation: Schema.String, active: counter }),
      UPDATE: Schema.Struct({
        ...now,
        name: AgentProfile.fields.name,
        instructions: AgentProfile.fields.instructions,
      }),
      ARCHIVE: Schema.Struct(now),
      RESTORE: Schema.Struct({ ...now, active: counter }),
    },
  },
}).createMachine({
  id: "agent-profile",
  version: "1",
  context: ({ input }) => input,
  initial: "absent",
  on: {
    CREATE: ({ context, event }) => {
      if (context.creation !== event.creation)
        throw new AgentConflict({
          message: "This creation request belongs to another bot.",
        })
    },
    UPDATE: ({ context, event }) => ({
      context: {
        ...bump(context, event.now),
        name: event.name.trim(),
        instructions: event.instructions,
      },
    }),
    ARCHIVE: ({ context, event }) => {
      if (context.id === homeAgentId)
        throw new AgentConflict({
          message: "Your original personal assistant stays available.",
        })
      return { target: ".archived", context: bump(context, event.now) }
    },
  },
  states: {
    absent: {
      on: {
        CREATE: ({ context, event }) => {
          requireAgentCapacity(event.active)
          return {
            target: "active",
            context: { ...context, creation: event.creation },
          }
        },
      },
    },
    active: {
      on: {
        RESTORE: ({ context, event }) => ({
          context: bump(context, event.now),
        }),
      },
    },
    archived: {
      on: {
        RESTORE: ({ context, event }) => {
          requireAgentCapacity(event.active)
          return { target: "active", context: bump(context, event.now) }
        },
      },
    },
  },
})
export type AgentEvent = EventFromLogic<typeof agentProfileMachine>
function noEffects(effects: readonly ExecutableEffect[]) {
  if (effects.length)
    throw new Error(`Unsupported agent profile effect: ${effects[0]!.type}`)
}
export function newAgentRecord(
  profile: AgentProfile,
  creation: string,
  active: number
) {
  const { status: _, ...context } = profile
  const [snapshot, effects] = initialTransition(agentProfileMachine, {
    ...context,
    schemaVersion: 1,
    workflowVersion: 1,
    creation,
  })
  noEffects(effects)
  return step(snapshot, { type: "CREATE", creation, active })
}
export function advanceAgentRecord(saved: unknown, event: AgentEvent) {
  const { status, ...context } = Schema.decodeUnknownSync(AgentRecord)(saved)
  return step(
    agentProfileMachine.resolveState({ value: status, context }),
    event
  )
}
function step(
  snapshot: ReturnType<typeof agentProfileMachine.resolveState>,
  event: AgentEvent
) {
  const [next, effects] = transition(agentProfileMachine, snapshot, event)
  noEffects(effects)
  return Schema.decodeUnknownSync(AgentRecord)({
    ...next.context,
    status: next.value,
  })
}
