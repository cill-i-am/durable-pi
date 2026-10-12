import { Effect } from "effect"
import type { BrowserFailure, BrowserObservation } from "../contracts"

export function browserResult(result: BrowserObservation) {
  return {
    content: [
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

/** A confirmed rejection is a native error result and therefore a replayable
 * receipt. Unknown dispatch outcomes still throw and keep Access's replay fence.
 */
export function browserToolResult(
  operation: Effect.Effect<BrowserObservation, BrowserFailure>
) {
  return operation.pipe(
    Effect.map(browserResult),
    Effect.catchTag("BrowserFailure", (error) =>
      error.outcome === "rejected"
        ? Effect.succeed({
            isError: true,
            content: [{ type: "text" as const, text: error.message }],
            diagnostics: [
              {
                severity: "error" as const,
                code: "browser_rejected",
                message: error.message,
              },
            ],
          })
        : Effect.fail(error)
    )
  )
}
