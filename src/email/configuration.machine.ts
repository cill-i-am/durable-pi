import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import {
  describeExecutableEffect,
  initialTransition,
  transition,
  type ExecutableEffect,
} from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import { ConfigureEmail, EmailSettings } from "./contracts"

/** The settings row is authoritative; enabled reconstructs the machine state. */
export const EmailConfiguration = Schema.Struct({
  ...EmailSettings.fields,
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
})
const { enabled: _, ...fields } = EmailConfiguration.fields
const Context = Schema.Struct(fields)
const Command = Schema.Union([
  Schema.Struct({ type: Schema.Literal("cancel-pending") }),
  Schema.Struct({ type: Schema.Literal("rejected"), message: Schema.String }),
])

export const emailConfigurationMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: Context,
    context: Context,
    events: { CONFIGURE: ConfigureEmail },
    emitted: {
      "cancel-pending": Schema.Struct({}),
      rejected: Schema.Struct({ message: Schema.String }),
    },
  },
}).createMachine({
  id: "email-configuration",
  version: "1",
  context: ({ input }) => input,
  initial: "enabled",
  on: {
    CONFIGURE: ({ context, event, value }, enq) => {
      const enabled = value === "enabled"
      if (context.operationId === event.operationId) {
        if (
          enabled !== event.enabled ||
          context.revision !== event.revision + 1
        )
          enq.emit({
            type: "rejected",
            message: "This request belongs to different email settings.",
          })
        return
      }
      if (context.revision !== event.revision) {
        enq.emit({
          type: "rejected",
          message: "Email settings changed. Reload before saving.",
        })
        return
      }
      if (!event.enabled) enq.emit({ type: "cancel-pending" })
      return {
        target: event.enabled ? ".enabled" : ".disabled",
        context: {
          ...context,
          revision: context.revision + 1,
          generation: context.generation + (event.enabled && !enabled ? 1 : 0),
          operationId: event.operationId,
        },
      }
    },
  },
  states: { enabled: {}, disabled: {} },
})
export function emailConfigurationCommands(
  effects: readonly ExecutableEffect[]
) {
  return effects.map((effect) => {
    const descriptor = describeExecutableEffect(effect)
    if (descriptor.kind === "emit")
      return Schema.decodeUnknownSync(Command)(descriptor.event)
    throw new Error(`Unsupported email configuration effect: ${effect.type}`)
  })
}
export function readEmailConfiguration(saved: unknown | undefined) {
  if (saved !== undefined)
    return Schema.decodeUnknownSync(EmailConfiguration)(saved)
  const [snapshot, effects] = initialTransition(emailConfigurationMachine, {
    revision: 0,
    generation: 1,
    operationId: "",
    schemaVersion: 1,
    workflowVersion: 1,
  })
  if (effects.length)
    throw new Error("Unsupported email configuration initialization effect")
  return Schema.decodeUnknownSync(EmailConfiguration)({
    ...snapshot.context,
    enabled: snapshot.matches("enabled"),
  })
}
export function configureEmail(saved: unknown, input: ConfigureEmail) {
  const { enabled, ...context } = readEmailConfiguration(saved)
  const [next, effects] = transition(
    emailConfigurationMachine,
    emailConfigurationMachine.resolveState({
      value: enabled ? "enabled" : "disabled",
      context,
    }),
    { type: "CONFIGURE", ...input }
  )
  return {
    record: Schema.decodeUnknownSync(EmailConfiguration)({
      ...next.context,
      enabled: next.matches("enabled"),
    }),
    commands: emailConfigurationCommands(effects),
  }
}
