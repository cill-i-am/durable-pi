import { Cause, Effect } from "effect"

import type { BrowserFailure, BrowserObservation } from "../contracts"
import type { BrowserStorageError } from "../repository"

export function browserResult(result: BrowserObservation) {
  return {
    output: [
      {
        type: "text" as const,
        text: JSON.stringify({
          ...result.page,
          generation: result.generation,
          version: result.version,
          viewport: { width: 1024, height: 768 },
        }),
      },
      ...(result.screenshot
        ? [
            {
              type: "image" as const,
              data: result.screenshot,
              mimeType: "image/jpeg",
            },
          ]
        : []),
    ],
  }
}

export function browserToolResult<TRequirements>(
  operation: Effect.Effect<
    BrowserObservation,
    BrowserFailure | BrowserStorageError,
    TRequirements
  >
) {
  return operation.pipe(
    Effect.map(browserResult),
    Effect.catchCause((cause) => {
      // A typed failure may accompany a cleanup defect or interruption.
      if (Cause.hasDies(cause) || Cause.hasInterrupts(cause))
        return Effect.failCause(cause)
      return Effect.failCause(cause).pipe(
        Effect.catchTag("BrowserFailure", (error) =>
          error.outcome === "rejected" || error.outcome === "failed"
            ? Effect.succeed({
                isError: true,
                output: [{ type: "text" as const, text: error.message }],
                diagnostics: [
                  {
                    severity: "error" as const,
                    code:
                      error.outcome === "failed"
                        ? "browser_load_failed"
                        : "browser_rejected",
                    message: error.message,
                  },
                ],
              })
            : Effect.fail(error)
        )
      )
    })
  )
}
