import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import type { AgentCatalog } from "./catalog"
import { AgentProfile, type AgentError, type AgentId } from "./domain"

export function archiveMachine<E, R>(
  catalog: AgentCatalog["Service"],
  project: (owner: string, profile: AgentProfile) => Effect.Effect<void, E, R>,
  owner: string,
  id: AgentId,
  archived: boolean
) {
  const outcome = Schema.declare(
    (value): value is Exit.Exit<AgentProfile, AgentError | E> =>
      Exit.isExit(value)
  )
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        profile: Schema.UndefinedOr(Schema.toType(AgentProfile)),
        outcome: Schema.UndefinedOr(outcome),
      }),
      output: outcome,
    },
    actors: {
      publish: createEffectLogic(
        Effect.exit(Effect.suspend(() => catalog.archive(id, archived)))
      ),
      project: createEffectLogic(({ input }: { input: AgentProfile }) =>
        Effect.exit(project(owner, input))
      ),
    },
  }).createMachine({
    id: "agent-archive",
    context: () => ({
      profile: undefined as AgentProfile | undefined,
      outcome: undefined as Exit.Exit<AgentProfile, AgentError | E> | undefined,
    }),
    output: ({ context }) => context.outcome!,
    initial: "publishing",
    states: {
      publishing: {
        invoke: {
          src: "publish",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: { ...context, outcome: event.output },
                }
              : {
                  target: "projecting",
                  context: { ...context, profile: event.output.value },
                },
        },
      },
      projecting: {
        invoke: {
          src: "project",
          input: ({ context }) => context.profile!,
          onDone: ({ context, event }) => ({
            target: "settled",
            context: {
              ...context,
              outcome: Exit.isFailure(event.output)
                ? Exit.failCause(event.output.cause)
                : Exit.succeed(context.profile!),
            },
          }),
        },
      },
      settled: { type: "final" },
    },
  })
}
