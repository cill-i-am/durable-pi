import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { AgentProfile } from "@/agents/contracts"

const command = Schema.Struct({
  agent: Schema.toType(AgentProfile),
  archived: Schema.Boolean,
})
export type AgentArchive = typeof command.Type
export function agentArchiveMachine(work: {
  write: (command: AgentArchive) => Effect.Effect<void, unknown>
  reconcile: (command: AgentArchive) => Effect.Effect<void, unknown>
}) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        command: Schema.NullOr(command),
        error: Schema.String,
        failure: Schema.Unknown,
      }),
      events: {
        REQUEST: command,
        CONFIRM: Schema.Struct({}),
        DISMISS: Schema.Struct({}),
        RECONCILE: Schema.Struct({}),
      },
    },
    actors: {
      write: createEffectLogic(({ input }: { input: AgentArchive }) =>
        Effect.exit(work.write(input))
      ),
      reconcile: createEffectLogic(({ input }: { input: AgentArchive }) =>
        Effect.exit(work.reconcile(input))
      ),
    },
  }).createMachine({
    id: "agent-archive",
    initial: "ready",
    context: { command: null, error: "", failure: null },
    states: {
      ready: {
        on: {
          REQUEST: ({ event }) => ({
            target: event.archived ? "confirming" : "writing",
            context: {
              command: { agent: event.agent, archived: event.archived },
              error: "",
              failure: null,
            },
          }),
        },
      },
      confirming: {
        on: {
          CONFIRM: { target: "writing" },
          DISMISS: {
            target: "ready",
            context: { command: null, error: "", failure: null },
          },
        },
      },
      writing: {
        invoke: {
          src: "write",
          input: ({ context }) => context.command!,
          onDone: ({ context, event }) => {
            if (Exit.isSuccess(event.output)) return { target: "reconciling" }
            const reason = event.output.cause.reasons.find(
              (reason) => reason._tag === "Fail"
            )
            return {
              target: context.command!.archived ? "confirming" : "ready",
              context: {
                ...context,
                failure: event.output.cause,
                error:
                  reason?._tag === "Fail" &&
                  Schema.is(Schema.Struct({ message: Schema.String }))(
                    reason.error
                  )
                    ? reason.error.message
                    : "Could not update this agent. Try again.",
              },
            }
          },
        },
      },
      reconciling: {
        invoke: {
          src: "reconcile",
          input: ({ context }) => context.command!,
          onDone: ({ context, event }) =>
            Exit.isSuccess(event.output)
              ? {
                  target: "ready",
                  context: { command: null, error: "", failure: null },
                }
              : {
                  target: "unreconciled",
                  context: {
                    ...context,
                    error:
                      "Agent updated, but the list could not refresh. Try refreshing it.",
                    failure: event.output.cause,
                  },
                },
        },
      },
      unreconciled: { on: { RECONCILE: { target: "reconciling" } } },
    },
  })
}
