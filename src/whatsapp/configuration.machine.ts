import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import {
  describeExecutableEffect,
  initialTransition,
  transition,
  type EventFromLogic,
  type ExecutableEffect,
} from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import { AgentId, homeAgentId } from "../agents/domain"
import { ConfigureWhatsApp, WhatsAppSettings } from "./contracts"

/** Route and operation receipt changes commit with the inbound message. */
export const WhatsAppConfiguration = Schema.Struct({
  ...WhatsAppSettings.fields,
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
})
const { enabled: _, ...fields } = WhatsAppConfiguration.fields
const Context = Schema.toType(Schema.Struct(fields))
const Command = Schema.Union([
  Schema.Struct({ type: Schema.Literal("cancel-pending") }),
  Schema.Struct({ type: Schema.Literal("rejected"), message: Schema.String }),
])

export const whatsappConfigurationMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: Context,
    context: Context,
    events: {
      CONFIGURE: Schema.toType(
        Schema.Struct({ ...ConfigureWhatsApp.fields, agentId: AgentId })
      ),
      INBOUND: Schema.toType(
        Schema.Struct({
          timestamp: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
          route: Schema.NullOr(AgentId),
        })
      ),
    },
    emitted: {
      "cancel-pending": Schema.Struct({}),
      rejected: Schema.Struct({ message: Schema.String }),
    },
  },
}).createMachine({
  id: "whatsapp-configuration",
  version: "1",
  context: ({ input }) => input,
  initial: "disabled",
  on: {
    CONFIGURE: ({ context, event, value }, enq) => {
      const enabled = value === "enabled"
      if (context.operationId === event.operationId) {
        if (
          enabled !== event.enabled ||
          context.agentId !== event.agentId ||
          context.revision !== event.revision + 1
        )
          enq.emit({
            type: "rejected",
            message: "This request belongs to different WhatsApp settings.",
          })
        return
      }
      if (context.revision !== event.revision) {
        enq.emit({
          type: "rejected",
          message: "WhatsApp settings changed. Reload before saving.",
        })
        return
      }
      if (!event.enabled) enq.emit({ type: "cancel-pending" })
      return {
        target: event.enabled ? ".enabled" : ".disabled",
        context: {
          ...context,
          agentId: event.agentId,
          revision: context.revision + 1,
          generation: context.generation + (event.enabled && !enabled ? 1 : 0),
          operationId: event.operationId,
        },
      }
    },
  },
  states: {
    disabled: {},
    enabled: {
      on: {
        INBOUND: ({ context, event }) => ({
          context: {
            ...context,
            lastInboundAt: Math.max(context.lastInboundAt, event.timestamp),
            ...(event.route === null
              ? {}
              : {
                  agentId: event.route,
                  revision: context.revision + 1,
                  operationId: "",
                }),
          },
        }),
      },
    },
  },
})
export type WhatsAppConfigurationEvent = EventFromLogic<
  typeof whatsappConfigurationMachine
>
export function whatsappConfigurationCommands(
  effects: readonly ExecutableEffect[]
) {
  return effects.map((effect) => {
    const descriptor = describeExecutableEffect(effect)
    if (descriptor.kind === "emit")
      return Schema.decodeUnknownSync(Command)(descriptor.event)
    throw new Error(`Unsupported WhatsApp configuration effect: ${effect.type}`)
  })
}
export function readWhatsAppConfiguration(saved: unknown | undefined) {
  if (saved !== undefined)
    return Schema.decodeUnknownSync(WhatsAppConfiguration)(saved)
  const [snapshot, effects] = initialTransition(whatsappConfigurationMachine, {
    agentId: homeAgentId,
    revision: 0,
    generation: 0,
    operationId: "",
    lastInboundAt: 0,
    schemaVersion: 1,
    workflowVersion: 1,
  })
  if (effects.length)
    throw new Error("Unsupported WhatsApp configuration initialization effect")
  return Schema.decodeUnknownSync(WhatsAppConfiguration)({
    ...snapshot.context,
    enabled: snapshot.matches("enabled"),
  })
}
export function advanceWhatsAppConfiguration(
  saved: unknown,
  event: WhatsAppConfigurationEvent
) {
  const { enabled, ...context } = readWhatsAppConfiguration(saved)
  const [next, effects] = transition(
    whatsappConfigurationMachine,
    whatsappConfigurationMachine.resolveState({
      value: enabled ? "enabled" : "disabled",
      context,
    }),
    event
  )
  return {
    record: Schema.decodeUnknownSync(WhatsAppConfiguration)({
      ...next.context,
      enabled: next.matches("enabled"),
    }),
    commands: whatsappConfigurationCommands(effects),
  }
}
