import { createEffectActor, waitFor } from "@xstate/effect"
import { Cause, Effect, Equal, Exit, Ref, Schema } from "effect"

import { fatalCause, orDieAll, preserveFatal } from "../shared/effect"
import { commandClientMachine } from "./client.machine"
import {
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
  return Effect.gen(function* () {
    yield* Effect.yieldNow
    const command = yield* Schema.decodeUnknownEffect(CommandInput)(input).pipe(
      preserveFatal,
      Effect.mapError(
        () => new TerminalFailure({ message: "Invalid command request." })
      )
    )
    // Once Stop starts, its acknowledgement remains owned even if the caller
    // interrupts the deadline cancellation itself.
    const cancelled = yield* Effect.cached(
      client.cancel.pipe(Effect.uninterruptible)
    )
    const failed = yield* Ref.make<Cause.Cause<TerminalRuntimeError>[]>([])
    const observe = <A>(work: Effect.Effect<A, TerminalRuntimeError>) =>
      work.pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? Ref.update(failed, (causes) => [...causes, exit.cause])
            : Effect.void
        )
      )
    return yield* Effect.gen(function* () {
      const actor = yield* createEffectActor(
        commandClientMachine(command, {
          start: observe(client.start),
          read: observe(client.read),
          state: observe(client.state),
          cancel: observe(cancelled),
        })
      )
      const done = yield* waitFor(
        actor,
        (state) => state.status === "done"
      ).pipe(
        Effect.orDie,
        // Fence before scope closure joins a possibly held acknowledgement.
        Effect.onInterrupt(() => cancelled.pipe(Effect.asVoid, orDieAll))
      )
      return yield* done.output!
    }).pipe(
      Effect.scoped,
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          // Stopping an official invocation joins its cleanup but can discard
          // its late Exit. Preserve every missing non-interruption reason.
          const retained = Exit.isFailure(exit) ? exit.cause.reasons : []
          const failures = yield* Ref.get(failed)
          const missing = failures.flatMap((cause) =>
            cause.reasons.filter(
              (reason) =>
                reason._tag !== "Interrupt" &&
                !retained.some(
                  (present) =>
                    Equal.equals(present, reason) ||
                    (present._tag === "Die" &&
                      reason._tag === "Fail" &&
                      Equal.equals(present.defect, reason))
                )
            )
          )
          if (missing.length)
            return yield* Effect.failCause(
              fatalCause(Cause.fromReasons(missing))
            )
        })
      ),
      preserveFatal
    )
  })
}
