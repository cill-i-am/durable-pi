import { Effect } from "effect"
import {
  nativeOperation,
  nativeResponse,
  releaseUnreadResponse,
} from "../../shared/interop"
import { observeCleanup } from "../../shared/effect"
import { ExecutorUnavailable } from "../executor"

export interface ExecutionTransport {
  fetch: (request: Request) => Promise<Response>
}

export const executionNativeOperation = <T>(
  start: (signal: AbortSignal) => Promise<T>
) => nativeOperation(start, () => new ExecutorUnavailable())
export const releaseExecutionResponse = releaseUnreadResponse
export const executionResponse = (
  start: (signal: AbortSignal) => Promise<Response>
) => nativeResponse(start, () => new ExecutorUnavailable())

/** A native signal is a foreign cancellation boundary, not a new runtime. */
export const executionWithSignal = <T, TError, TRequirements>(
  work: Effect.Effect<T, TError, TRequirements>,
  signal: AbortSignal
): Effect.Effect<T, TError, TRequirements> =>
  Effect.suspend(() => {
    if (signal.aborted) return Effect.interrupt
    return observeCleanup(work, (observed) =>
      Effect.raceFirst(
        observed,
        Effect.callback<never>((resume) => {
          const abort = () => resume(Effect.interrupt)
          signal.addEventListener("abort", abort, { once: true })
          if (signal.aborted) abort()
          return Effect.sync(() => signal.removeEventListener("abort", abort))
        })
      )
    )
  })
