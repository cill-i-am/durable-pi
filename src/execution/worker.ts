import { Effect } from "effect"
import type { ExecutionEnv } from "../../alchemy.run"
import { preserveFatal } from "../shared/effect"
import { runObserved } from "../observability/worker"
import { CodeInput } from "./contracts"
import { executeCode, type ExecutionLoader } from "./adapters/dynamic-worker"
import { executionJson } from "./adapters/input"

export async function executionWorkerRequest(
  request: Request,
  loader: ExecutionLoader
) {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/run")
    return new Response("Not found", { status: 404 })
  return runObserved(
    Effect.yieldNow.pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const input = yield* executionJson(request, CodeInput)
          return Response.json(yield* executeCode(loader, input))
        })
      ),
      preserveFatal,
      Effect.catchTag("ExecutorUnavailable", () =>
        Effect.succeed(
          Response.json(
            { error: "Code execution failed or exceeded its limits." },
            { status: 422 }
          )
        )
      )
    ),
    { signal: request.signal }
  )
}

export default {
  fetch: (request: Request, env: Pick<ExecutionEnv, "LOADER">) =>
    executionWorkerRequest(request, env.LOADER),
}
