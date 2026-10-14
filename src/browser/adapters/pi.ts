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

export function browserToolResult(
  operation: Effect.Effect<BrowserObservation, BrowserFailure>
) {
  return operation.pipe(
    Effect.map(browserResult),
    Effect.catchTag("BrowserFailure", (error) =>
      error.outcome === "rejected" || error.outcome === "failed"
        ? Effect.succeed({
            isError: true,
            content: [{ type: "text" as const, text: error.message }],
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
}
