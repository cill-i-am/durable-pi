import { Cause, Effect, Schema } from "effect"

import { orDieAll } from "../../shared/effect"
import { nativeFailure, nativeOperation } from "../../shared/interop"
import { completeCommand } from "../command-client"
import {
  CommandRun,
  TerminalState,
  type CommandInput,
  type TerminalFailure,
} from "../contracts"
import { TerminalRuntimeError } from "../runtime"
import { readBounded } from "./stream"

export interface TerminalBinding {
  fetch: (request: Request) => Promise<Response>
}
const RECEIPT_BYTES = 512 * 1024
const STATE_BYTES = 512 * 1024

/** Native response mechanics only. Every body is consumed within its budget or
 * cancelled, including a response acquired after the request signal aborts. */
async function request<T>(
  service: TerminalBinding,
  identity: string,
  path: string,
  schema: Schema.ConstraintDecoder<T>,
  signal: AbortSignal,
  maximum: number,
  body?: unknown
): Promise<T> {
  const response = await service.fetch(
    new Request(
      `https://terminal.internal/${identity}/terminal${path ? `/${path}` : ""}`,
      {
        method: body === undefined ? "GET" : "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }
    )
  )
  let failure: { cause: unknown } | undefined
  let value: { value: T } | undefined
  try {
    if (!response.ok || !response.body)
      throw new Error("Terminal receipt unavailable")
    const bytes = await readBounded(response.body, maximum, signal)
    value = {
      value: Schema.decodeUnknownSync(Schema.fromJsonString(schema))(
        new TextDecoder().decode(bytes)
      ),
    }
  } catch (cause) {
    failure = { cause }
  }
  if (response.body && !response.bodyUsed && !response.body.locked) {
    try {
      await response.body.cancel()
    } catch (cause) {
      throw Cause.fromReasons([
        ...(failure
          ? Cause.isCause(failure.cause)
            ? failure.cause.reasons
            : [Cause.makeFailReason(failure.cause)]
          : []),
        Cause.makeDieReason(cause),
      ])
    }
  }
  if (failure) throw failure.cause
  if (value) return value.value
  throw Cause.die(new Error("Terminal response omitted its decoded receipt"))
}

/** Each invocation owns one memoized cancellation fence. Native request
 * finalizers send it before joining late admission or polling replies. */
export function runCommand(
  service: TerminalBinding,
  identity: string,
  input: CommandInput
): Effect.Effect<CommandRun, TerminalFailure | TerminalRuntimeError> {
  return Effect.gen(function* () {
    const command = { ...input },
      id = encodeURIComponent(command.id)
    const rejected = (operation: string) => (cause: unknown) =>
      new TerminalRuntimeError({ operation, cause })
    const cancel = yield* Effect.cached(
      nativeOperation(
        (signal) =>
          request(
            service,
            identity,
            `${id}/cancel`,
            Schema.NullOr(CommandRun),
            signal,
            RECEIPT_BYTES,
            {}
          ),
        rejected("cancel command")
      ).pipe(
        Effect.flatMap((run) =>
          run === null || run.id === command.id
            ? Effect.succeed(run)
            : Effect.fail(
                rejected("cancel command")("Different receipt identity")
              )
        )
      )
    )
    const call = <T>(
      operation: string,
      path: string,
      schema: Schema.ConstraintDecoder<T>,
      maximum: number,
      body?: unknown
    ) =>
      Effect.callback<T, TerminalRuntimeError>((resume, signal) => {
        let failed: Cause.Cause<TerminalRuntimeError> | undefined
        const work = request(
          service,
          identity,
          path,
          schema,
          signal,
          maximum,
          body
        )
        work.then(
          (value) => resume(Effect.succeed(value)),
          (cause: unknown) => {
            failed = nativeFailure(cause, rejected(operation))
            resume(Effect.failCause(failed))
          }
        )
        const settle = Effect.promise(() =>
          work.then(
            () => undefined,
            () => undefined
          )
        ).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              failed && Cause.hasDies(failed)
                ? Effect.failCause(failed).pipe(orDieAll)
                : Effect.void
            )
          )
        )
        return cancel.pipe(Effect.asVoid, orDieAll, Effect.ensuring(settle))
      })
    return yield* completeCommand(command, {
      start: call("admit command", "run", CommandRun, RECEIPT_BYTES, command),
      cancel,
      read: call("read command", id, CommandRun, RECEIPT_BYTES),
      state: call("read terminal state", "", TerminalState, STATE_BYTES),
    })
  })
}
