import type {
  ToolRegistration,
  ToolExecutionResult,
  ToolExecutionApi,
} from "@earendil-works/pi-durable"
import { createEffectActor, waitFor } from "@xstate/effect"
import { Cause, Effect, Equal, Exit, Schema } from "effect"

import { nativeOperation } from "../../shared/interop"
import {
  beginToolCallback,
  settleToolCallback,
  shareToolCallback,
  toolCallbackMachine,
  type ToolCallbackLease,
} from "../callback.machine"
import {
  ConnectionError,
  ConnectionStorageError,
  ConnectionTransportError,
} from "../connections"
import { AccessDenied, AccessConflict, AccessStorageError } from "../contracts"
import type { AccessGate } from "../gate"
import { toolReceipt } from "./receipt"

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
    { lease: ToolCallbackLease; promise: Promise<ToolExecutionResult> }
  >()
  return (tool: ToolRegistration): ToolRegistration => ({
    ...tool,
    replay: "safe",
    execute: (args, api, context) => {
      const id = String(api.taskId),
        serialized = JSON.stringify(args),
        input = JSON.stringify({ tool: tool.name, args: serialized })
      const existing = running.get(id)
      if (existing) {
        if (!shareToolCallback(existing.lease, input))
          return Promise.reject(new Error("Tool identity conflict"))
        return existing.promise
      }
      // Capture the native value with the same bytes used for admission. The
      // caller may reuse or mutate its argument object while authority waits.
      const admittedArgs = JSON.parse(serialized) as typeof args
      const failures: Cause.Cause<unknown>[] = []
      const observe = <T, E>(work: Effect.Effect<T, E>) =>
        work.pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (Exit.isFailure(exit)) failures.push(exit.cause)
            })
          )
        )
      const authority = observe(
        Effect.gen(function* () {
          const previous = yield* gate.operation(id)
          const resolved = yield* activeTurn(api)
          if (previous && resolved !== previous.turnId)
            return yield* new AccessDenied({
              message: "Tool ownership no longer matches its original request.",
            })
          const turnId = previous?.turnId ?? resolved
          if (!turnId)
            return yield* new AccessDenied({ message: "The reply has ended." })
          return turnId
        })
      )
      const program = Effect.gen(function* () {
        const actor = yield* createEffectActor(
          toolCallbackMachine({
            authority,
            execute: (turnId) =>
              observe(
                gate
                  .run(
                    { id, turnId, tool: tool.name, input: serialized },
                    nativeOperation(
                      (signal) =>
                        tool.execute(admittedArgs, api, {
                          ...context,
                          abortSignal: signal,
                        }),
                      (cause) => cause
                    ).pipe(Effect.map(toolReceipt)),
                    recoverableTools.has(tool.name)
                  )
                  .pipe(Effect.map(toolReceipt))
              ),
          })
        )
        const done = yield* waitFor(
          actor,
          (snapshot) => snapshot.status === "done"
        ).pipe(Effect.orDie)
        return yield* done.output!
      }).pipe(
        Effect.scoped,
        Effect.onExit((exit) => {
          if (!Exit.isFailure(exit) || !Cause.hasInterrupts(exit.cause))
            return Effect.void
          const reasons = failures
            .flatMap((cause) => cause.reasons)
            .filter(
              (reason, index, all) =>
                reason._tag !== "Interrupt" &&
                !exit.cause.reasons.some((present) =>
                  Equal.equals(present, reason)
                ) &&
                !all
                  .slice(0, index)
                  .some((present) => Equal.equals(present, reason))
            )
          return reasons.length
            ? Effect.failCause(Cause.fromReasons(reasons))
            : Effect.void
        })
      )
      const promise = Promise.resolve()
        .then(() => run(program, { signal: context.abortSignal }))
        .then((exit) => {
          if (Exit.isFailure(exit)) throw publicToolCause(exit.cause)
          return exit.value
        })
      const resource = { lease: beginToolCallback(input), promise }
      running.set(id, resource)
      void promise
        .finally(() => {
          // The callback runner resolves only after its complete actor/native
          // scope joins. Until then duplicates keep this exact pending Promise.
          resource.lease = settleToolCallback(resource.lease)
          if (running.get(id) === resource) running.delete(id)
        })
        .catch(() => {})
      return promise
    },
  })
}
