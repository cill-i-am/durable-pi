import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Exit, Effect, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import type { AgentConfigurationHost } from "./application"
import { AgentConfiguration, type BotConfiguration } from "./configuration"
import type { AgentConflict, AgentProfile, AgentStorageError } from "./domain"

/** A request owns publication, terminal acknowledgment and the subsequent wake
 * selection. The admission ledger remains the durable authority throughout. */
export function synchronizationMachine<E, R>(
  configuration: BotConfiguration["Service"],
  host: AgentConfigurationHost<E, R>,
  owner: string,
  profile: AgentProfile
) {
  type Failure = AgentConflict | AgentStorageError | E
  const outcome = Schema.declare((value): value is Exit.Exit<void, Failure> =>
    Exit.isExit(value)
  )
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        current: Schema.UndefinedOr(AgentConfiguration),
        outcome: Schema.UndefinedOr(outcome),
      }),
      output: outcome,
    },
    actors: {
      configure: createEffectLogic(
        Effect.exit(
          Effect.suspend(() => configuration.configure(owner, profile))
        )
      ),
      read: createEffectLogic(
        Effect.exit(Effect.suspend(() => configuration.read()))
      ),
      invalidate: createEffectLogic(
        Effect.exit(Effect.suspend(() => host.invalidateApps()))
      ),
      synchronize: createEffectLogic(
        ({ input }: { input: AgentConfiguration }) =>
          Effect.exit(
            host.syncTerminal({
              revision: input.revision,
              active: input.status === "active",
              revokeThrough:
                profile.status === "archived" ? profile.revision : undefined,
            })
          )
      ),
      browser: createEffectLogic(
        Effect.exit(Effect.suspend(() => host.wakeBrowser()))
      ),
      extractionPending: createEffectLogic(
        Effect.exit(Effect.suspend(() => host.extractionPending()))
      ),
      extraction: createEffectLogic(
        Effect.exit(Effect.suspend(() => host.wakeExtraction()))
      ),
      appsPending: createEffectLogic(
        Effect.exit(Effect.suspend(() => host.appsPending()))
      ),
      apps: createEffectLogic(
        Effect.exit(Effect.suspend(() => host.wakeApps()))
      ),
      routinesPending: createEffectLogic(
        Effect.exit(Effect.suspend(() => host.routinesPending()))
      ),
      routines: createEffectLogic(
        Effect.exit(Effect.suspend(() => host.wakeRoutines()))
      ),
    },
  }).createMachine({
    id: "agent-synchronization",
    context: () => ({
      current: undefined as AgentConfiguration | undefined,
      outcome: undefined as Exit.Exit<void, Failure> | undefined,
    }),
    output: ({ context }) => context.outcome!,
    initial: "configuring",
    states: {
      configuring: {
        invoke: {
          src: "configure",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: { ...context, outcome: event.output },
                }
              : { target: "reading" },
        },
      },
      reading: {
        invoke: {
          src: "read",
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output))
              return {
                target: "settled",
                context: {
                  ...context,
                  outcome: Exit.failCause(event.output.cause),
                },
              }
            const current = event.output.value
            if (!current)
              return {
                target: "settled",
                context: {
                  ...context,
                  outcome: Exit.die(
                    new Error("Configured bot has no configuration")
                  ),
                },
              }
            return {
              target:
                current.status === "archived"
                  ? "invalidating"
                  : "synchronizing",
              context: { ...context, current },
            }
          },
        },
      },
      invalidating: {
        invoke: {
          src: "invalidate",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: { ...context, outcome: event.output },
                }
              : { target: "synchronizing" },
        },
      },
      synchronizing: {
        invoke: {
          src: "synchronize",
          input: ({ context }) => context.current!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: { ...context, outcome: event.output },
                }
              : { target: "readingAuthority" },
        },
      },
      readingAuthority: {
        invoke: {
          src: "read",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : {
                  target:
                    event.output.value?.status === "archived"
                      ? "wakingBrowser"
                      : "checkingExtraction",
                },
        },
      },
      wakingBrowser: {
        invoke: {
          src: "browser",
          onDone: ({ context, event }) => ({
            target: "settled",
            context: { ...context, outcome: event.output },
          }),
        },
      },
      checkingExtraction: {
        invoke: {
          src: "extractionPending",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : {
                  target: event.output.value
                    ? "wakingExtraction"
                    : "checkingApps",
                },
        },
      },
      wakingExtraction: {
        invoke: {
          src: "extraction",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: { ...context, outcome: event.output },
                }
              : { target: "checkingApps" },
        },
      },
      checkingApps: {
        invoke: {
          src: "appsPending",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : {
                  target: event.output.value
                    ? "wakingApps"
                    : "checkingRoutines",
                },
        },
      },
      wakingApps: {
        invoke: {
          src: "apps",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: { ...context, outcome: event.output },
                }
              : { target: "checkingRoutines" },
        },
      },
      checkingRoutines: {
        invoke: {
          src: "routinesPending",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : event.output.value
                ? { target: "wakingRoutines" }
                : {
                    target: "settled",
                    context: { ...context, outcome: Exit.void },
                  },
        },
      },
      wakingRoutines: {
        invoke: {
          src: "routines",
          onDone: ({ context, event }) => ({
            target: "settled",
            context: { ...context, outcome: event.output },
          }),
        },
      },
      settled: { type: "final" },
    },
  })
}
