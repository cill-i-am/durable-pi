import { Effect } from "effect"
import type { CodeExecutor } from "../executor"
import { readOutput } from "./output"
import { executionResponse, type ExecutionTransport } from "./interop"

export function codeService(service: ExecutionTransport): CodeExecutor {
  return {
    run: (input) =>
      Effect.scoped(
        Effect.gen(function* () {
          const response = yield* executionResponse((signal) =>
            service.fetch(
              new Request("https://execution.internal/run", {
                method: "POST",
                redirect: "manual",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(input),
                signal,
              })
            )
          )
          return yield* readOutput(response)
        })
      ),
  }
}
