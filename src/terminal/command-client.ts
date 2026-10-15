import { Effect, Schema } from "effect"
import { observeCleanup, orDieAll, preserveFatal } from "../shared/effect"
import {
  COMMAND_TIMEOUT,
  CommandInput,
  type CommandRun,
  type TerminalState,
  TerminalFailure,
} from "./contracts"
import type { TerminalRuntimeError } from "./runtime"

/** One original command identity. Admission's adapter must fence cancellation
 * before joining a request whose acknowledgement may arrive after Stop. */
export interface CommandClient {
  readonly start: Effect.Effect<CommandRun, TerminalRuntimeError>
  readonly read: Effect.Effect<CommandRun, TerminalRuntimeError>
  readonly state: Effect.Effect<TerminalState, TerminalRuntimeError>
  readonly cancel: Effect.Effect<CommandRun | null, TerminalRuntimeError>
}
export function completeCommand(
  input: CommandInput,
  client: CommandClient
): Effect.Effect<CommandRun, TerminalFailure | TerminalRuntimeError> {
  const work = Effect.gen(function* () {
    yield* Effect.yieldNow
    const command = yield* Schema.decodeUnknownEffect(CommandInput)(input).pipe(
      preserveFatal,
      Effect.mapError(
        () => new TerminalFailure({ message: "Invalid command request." })
      )
    )
    const receipt = (run: CommandRun) =>
      run.id === command.id &&
      run.command === command.command &&
      (run.kind ?? "command") === "command"
        ? Effect.succeed(run)
        : Effect.fail(
            new TerminalFailure({
              message: "This command identity belongs to different input.",
            })
          )
    return yield* Effect.gen(function* () {
      let result = yield* receipt(yield* client.start)
      for (;;) {
        if (result.status !== "running") {
          const state = yield* client.state
          if (state.cleanupError)
            return { ...result, error: state.cleanupError }
          if (!state.busy) return result
        }
        yield* Effect.sleep("500 millis")
        result = yield* receipt(yield* client.read)
      }
    }).pipe(
      Effect.onInterrupt(() => client.cancel.pipe(Effect.asVoid, orDieAll))
    )
  })
  return observeCleanup(work, (observed) =>
    Effect.timeout(observed, COMMAND_TIMEOUT + 15_000)
  ).pipe(
    preserveFatal,
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        new TerminalFailure({
          message:
            "The command status could not be confirmed within its observation window. Inspect Terminal before starting another command.",
        })
      )
    )
  )
}
