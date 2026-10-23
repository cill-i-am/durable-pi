import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { orDieAll } from "../shared/effect"
import type { CommandClient } from "./command-client"
import {
  COMMAND_TIMEOUT,
  CommandRun,
  type CommandInput,
  TerminalFailure,
} from "./contracts"
import type { TerminalRuntimeError } from "./runtime"

type Failure = TerminalFailure | TerminalRuntimeError
const outcome = Schema.declare(
  (value): value is Exit.Exit<CommandRun, Failure> => Exit.isExit(value)
)
const expired = () =>
  new TerminalFailure({
    message:
      "The command status could not be confirmed within its observation window. Inspect Terminal before starting another command.",
  })

/** Observes one immutable command receipt. The deadline stops observation and
 * fences that identity; it never admits another command or confirms a remote Stop. */
export function commandClientMachine(
  command: CommandInput,
  client: CommandClient
) {
  const identity = { ...command }
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        result: Schema.NullOr(CommandRun),
        outcome: Schema.UndefinedOr(outcome),
      }),
      output: outcome,
    },
    actors: {
      start: createEffectLogic(Effect.exit(client.start)),
      read: createEffectLogic(Effect.exit(client.read)),
      state: createEffectLogic(Effect.exit(client.state)),
      cancel: createEffectLogic(Effect.exit(client.cancel.pipe(orDieAll))),
    },
  }).createMachine({
    id: "terminal-command-client",
    context: () => ({
      result: null as CommandRun | null,
      outcome: undefined as Exit.Exit<CommandRun, Failure> | undefined,
    }),
    output: ({ context }) => context.outcome!,
    initial: "observing",
    states: {
      observing: {
        after: { [COMMAND_TIMEOUT + 15_000]: { target: "timingOut" } },
        initial: "admitting",
        states: {
          admitting: {
            invoke: {
              src: "start",
              onDone: ({ context, event }) => ({
                target: "received",
                context: { ...context, outcome: event.output },
              }),
            },
          },
          reading: {
            invoke: {
              src: "read",
              onDone: ({ context, event }) => ({
                target: "received",
                context: { ...context, outcome: event.output },
              }),
            },
          },
          received: {
            always: ({ context }) => {
              const received = context.outcome!
              if (Exit.isFailure(received))
                return { target: "#terminal-command-client.settled" }
              const run = received.value
              if (
                run.id !== identity.id ||
                run.command !== identity.command ||
                (run.kind ?? "command") !== "command"
              )
                return {
                  target: "#terminal-command-client.settled",
                  context: {
                    ...context,
                    outcome: Exit.fail(
                      new TerminalFailure({
                        message:
                          "This command identity belongs to different input.",
                      })
                    ),
                  },
                }
              return {
                target:
                  run.status === "running" ? "waiting" : "checkingCleanup",
                context: { ...context, result: run },
              }
            },
          },
          checkingCleanup: {
            invoke: {
              src: "state",
              onDone: ({ context, event }) => {
                if (Exit.isFailure(event.output))
                  return {
                    target: "#terminal-command-client.settled",
                    context: {
                      ...context,
                      outcome: Exit.failCause(event.output.cause),
                    },
                  }
                const state = event.output.value
                return state.cleanupError || !state.busy
                  ? {
                      target: "#terminal-command-client.settled",
                      context: {
                        ...context,
                        outcome: Exit.succeed(
                          state.cleanupError
                            ? { ...context.result!, error: state.cleanupError }
                            : context.result!
                        ),
                      },
                    }
                  : { target: "waiting" }
              },
            },
          },
          waiting: { after: { 500: { target: "reading" } } },
        },
      },
      timingOut: {
        invoke: {
          src: "cancel",
          onDone: ({ context, event }) => ({
            target: "settled",
            context: {
              ...context,
              outcome: Exit.failCause(
                Cause.fromReasons([
                  Cause.makeFailReason(expired()),
                  ...(Exit.isFailure(event.output)
                    ? event.output.cause.reasons
                    : []),
                ])
              ),
            },
          }),
        },
      },
      settled: { type: "final" },
    },
  })
}
