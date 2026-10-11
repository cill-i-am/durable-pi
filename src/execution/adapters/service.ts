import type { CodeExecutor } from "../execution"
import { readOutput } from "./dynamic-worker"

export function codeService(service: Fetcher): CodeExecutor {
  return {
    run: async (input, signal) =>
      readOutput(
        await service.fetch(
          new Request("https://execution.internal/run", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
            signal,
          })
        ),
        signal
      ),
  }
}
