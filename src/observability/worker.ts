import { layer as CloudflareTracer } from "alchemy/Cloudflare/Workers/CloudflareTracer"
import { Effect, Layer } from "effect"
import { OperationalLogger } from "./logger"

/** Alchemy's native tracer must be built in the invocation, never cached in a DO.
 * Cloudflare owns propagation, sampling and export; no exporter or flush loop.
 */
export const WorkerTelemetry = Layer.mergeAll(
  CloudflareTracer,
  OperationalLogger
)

/** Promise bridge for native Worker/Pi callbacks. Requirements stay explicit. */
export function runObserved<TValue, TError>(
  operation: Effect.Effect<TValue, TError>,
  options?: { readonly signal?: AbortSignal }
): Promise<TValue> {
  return Effect.runPromise(
    operation.pipe(Effect.provide(WorkerTelemetry)),
    options
  )
}
