import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { initialTransition, transition } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import { AgentConfiguration } from "./configuration"
import { AgentConflict, AgentProfile } from "./domain"

export const ConfigurationRecord = Schema.Struct({
  ...AgentConfiguration.fields,
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
})
export type ConfigurationRecord = typeof ConfigurationRecord.Type
const { status: _, ...fields } = ConfigurationRecord.fields
const Context = Schema.Struct(fields)

export const configurationMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: Context,
    context: Context,
    events: {
      CONFIGURE: Schema.Struct({
        owner: Schema.String,
        profile: Schema.toType(AgentProfile),
      }),
    },
  },
}).createMachine({
  id: "agent-admission",
  version: "1",
  context: ({ input }) => input,
  initial: "unconfigured",
  on: {
    CONFIGURE: ({ context, event }) => {
      if (context.owner !== event.owner)
        throw new AgentConflict({ message: "Owner mismatch" })
      if (context.revision >= event.profile.revision) return
      return {
        target: event.profile.status === "active" ? ".active" : ".archived",
        context: {
          ...context,
          instructions: event.profile.instructions,
          revision: event.profile.revision,
        },
      }
    },
  },
  states: { unconfigured: {}, active: {}, archived: {} },
})

export function configureRecord(
  saved: unknown | undefined,
  owner: string,
  profile: AgentProfile
) {
  const record =
    saved === undefined
      ? undefined
      : Schema.decodeUnknownSync(ConfigurationRecord)(saved)
  const { status: _, ...context } = record ?? {
    owner,
    instructions: "",
    revision: -1,
    status: "active",
    schemaVersion: 1 as const,
    workflowVersion: 1 as const,
  }
  const [fresh, effects] = initialTransition(configurationMachine, context)
  if (effects.length)
    throw new Error("Unsupported agent admission initialization effect")
  const snapshot = record
    ? configurationMachine.resolveState({ value: record.status, context })
    : fresh
  const [next, commands] = transition(configurationMachine, snapshot, {
    type: "CONFIGURE",
    owner,
    profile,
  })
  if (commands.length)
    throw new Error(`Unsupported agent admission effect: ${commands[0]!.type}`)
  return Schema.decodeUnknownSync(ConfigurationRecord)({
    ...next.context,
    status: next.value,
  })
}
