import { layer as CloudflareTracer } from "alchemy/Cloudflare/Workers/CloudflareTracer"
import { Effect, Layer } from "effect"

import { OperationalLogger } from "./logger"

export const WorkerTelemetry = Layer.mergeAll(
  CloudflareTracer,
  OperationalLogger
)

export function runObserved<TValue, TError>(
  operation: Effect.Effect<TValue, TError>,
  options?: { readonly signal?: AbortSignal }
): Promise<TValue> {
  return Effect.runPromise(
    operation.pipe(Effect.provide(WorkerTelemetry)),
    options
  )
}
