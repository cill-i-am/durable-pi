import { Cause, Effect, Exit, Schema } from "effect"
import type {
  ToolRegistration,
  ToolExecutionResult,
  ToolExecutionApi,
} from "@earendil-works/pi-durable"
import type { AccessGate } from "../gate"
import { nativeOperation } from "../../shared/interop"
import { toolReceipt } from "./receipt"
import { AccessDenied, AccessConflict, AccessStorageError } from "../contracts"
import {
  ConnectionError,
  ConnectionStorageError,
  ConnectionTransportError,
} from "../connections"

const ToolFailure = Schema.Union([
  AccessDenied,
  AccessConflict,
  AccessStorageError,
  ConnectionError,
  ConnectionStorageError,
  ConnectionTransportError,
])
/** Pi renders rejected values as strings. Preserve the Cause shape while keeping
 * private diagnostics and tracing annotations out of the model transcript. */
const publicToolCause = (cause: Cause.Cause<unknown>): Cause.Cause<unknown> =>
  Cause.fromReasons(
    cause.reasons.map((reason): Cause.Reason<unknown> => {
      switch (reason._tag) {
        case "Interrupt":
          return Cause.makeInterruptReason(reason.fiberId)
        case "Die":
          return Cause.makeDieReason("Tool execution failed unexpectedly.")
        case "Fail": {
          const known = Schema.decodeUnknownOption(ToolFailure)(reason.error)
          if (known._tag === "None")
            return Cause.makeFailReason(
              "The tool result could not be confirmed. Check its status before repeating an external action."
            )
          switch (known.value._tag) {
            case "AccessStorageError":
              return Cause.makeFailReason(
                new AccessStorageError({
                  operation: known.value.operation,
                  cause: "Tool access storage unavailable.",
                })
              )
            case "ConnectionStorageError":
              return Cause.makeFailReason(
                new ConnectionStorageError({
                  operation: known.value.operation,
                  cause: "Tool connection storage unavailable.",
                })
              )
            case "ConnectionTransportError":
              return Cause.makeFailReason(
                new ConnectionTransportError({
                  operation: known.value.operation,
                  cause: "Tool connection unavailable.",
                })
              )
            default:
              return Cause.makeFailReason(known.value)
          }
        }
      }
    })
  )
type ToolCallbackRunner = <TValue, TError>(
  program: Effect.Effect<TValue, TError>,
  options?: Parameters<typeof Effect.runPromiseExit>[1]
) => Promise<Exit.Exit<TValue, unknown>>
export function guardedTools<TError>(
  gate: AccessGate,
  activeTurn: (
    api: ToolExecutionApi
  ) => Effect.Effect<string | undefined, TError>,
  recoverableTools: ReadonlySet<string> = new Set(),
  run: ToolCallbackRunner = Effect.runPromiseExit
) {
  const running = new Map<
    string,
    { input: string; promise: Promise<ToolExecutionResult> }
  >()
  return (tool: ToolRegistration): ToolRegistration => ({
    ...tool,
    replay: "safe",
    execute: (args, api, context) => {
      const id = String(api.taskId),
        input = JSON.stringify({ tool: tool.name, args })
      const existing = running.get(id)
      if (existing) {
        if (existing.input !== input)
          return Promise.reject(new Error("Tool identity conflict"))
        return existing.promise
      }
      const promise = run(
        Effect.gen(function* () {
          yield* Effect.yieldNow
          const previous = yield* gate.operation(id)
          const resolved = yield* activeTurn(api)
          if (previous && resolved !== previous.turnId)
            return yield* new AccessDenied({
              message: "Tool ownership no longer matches its original request.",
            })
          const turnId = previous?.turnId ?? resolved
          if (!turnId)
            return yield* new AccessDenied({ message: "The reply has ended." })
          return yield* gate.run(
            { id, turnId, tool: tool.name, input: JSON.stringify(args) },
            nativeOperation(
              (signal) =>
                tool.execute(args, api, { ...context, abortSignal: signal }),
              (cause) => cause
            ).pipe(Effect.map(toolReceipt)),
            recoverableTools.has(tool.name)
          )
        }),
        { signal: context.abortSignal }
      ).then((exit) => {
        if (Exit.isFailure(exit)) throw publicToolCause(exit.cause)
        return exit.value
      })
      running.set(id, { input, promise })
      void promise
        .finally(() => {
          if (running.get(id)?.promise === promise) running.delete(id)
        })
        .catch(() => {})
      return promise
    },
  })
}
