import type { Effect } from "effect"
import type { InferenceUsage } from "../usage"
import type { Attempt, TerminalOutcome, UsageReport } from "../usage-domain"

export interface NativeInferenceObservation {
  readonly id: string
  readonly turnId: string | null
  usage: (report: UsageReport) => void | Promise<void>
  end: (outcome: TerminalOutcome, error?: string | null) => void | Promise<void>
}

/** The owning stream awaits admission, each usage hook and final settlement.
 * Its retained runtime preserves the complete Cause through modelCallback. */
export function piUsage(
  service: typeof InferenceUsage.Service,
  run: <T, TError>(work: Effect.Effect<T, TError>) => Promise<T>,
  onFinished?: (attempt: Attempt) => void
) {
  return async (
    ...args: Parameters<typeof service.start>
  ): Promise<NativeInferenceObservation> => {
    const observation = await run(service.start(...args))
    return {
      id: observation.id,
      turnId: observation.turnId,
      usage: (report) => run(observation.usage(report)),
      end: async (outcome, error) => {
        const finished = await run(observation.end(outcome, error))
        if (finished) onFinished?.(finished)
      },
    }
  }
}
