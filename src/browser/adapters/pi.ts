import type { BrowserObservation } from "../contracts"

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
