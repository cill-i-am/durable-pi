import type { Effect } from "effect"
import type { InferenceUsage } from "../usage"
import type { Attempt, TerminalOutcome, UsageReport } from "../usage-domain"

export interface NativeInferenceObservation {
  readonly id: string
  readonly turnId: string | null
  usage: (report: UsageReport) => void
  end: (outcome: TerminalOutcome, error?: string | null) => void
}

/** Pi invokes these synchronous callbacks outside an Effect fiber. The host
 * supplies its retained runtime; the application never runs an Effect. */
export function piUsage(
  service: typeof InferenceUsage.Service,
  run: <T, TError>(work: Effect.Effect<T, TError>) => T,
  onFinished?: (attempt: Attempt) => void
) {
  return (
    ...args: Parameters<typeof service.start>
  ): NativeInferenceObservation => {
    const observation = run(service.start(...args))
    return {
      id: observation.id,
      turnId: observation.turnId,
      usage: (report) => run(observation.usage(report)),
      end: (outcome, error) => {
        const finished = run(observation.end(outcome, error))
        if (finished) onFinished?.(finished)
      },
    }
  }
}
