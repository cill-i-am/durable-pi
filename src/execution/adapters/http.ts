import { preserveFatal } from "../../shared/effect"
import { Effect, Schema } from "effect"
import { executionJson } from "./input"
import {
  RunInput,
  RunId,
  ExecutionFailure,
  type ExecutionStorageError,
} from "../contracts"
import type { ExecutionOperations } from "../execution"

export function executionRequest(
  executions: ExecutionOperations,
  request: Request,
  path: string,
  keepAlive: (task: Effect.Effect<unknown, ExecutionStorageError>) => void
) {
  return Effect.gen(function* () {
    if (path === "execution" && request.method === "GET")
      return Response.json({ runs: yield* executions.list() })
    if (path === "execution/run" && request.method === "POST") {
      const input = yield* executionJson(request, RunInput).pipe(
        preserveFatal,
        Effect.mapError(
          () => new ExecutionFailure({ message: "Invalid execution request." })
        )
      )
      const operation = yield* executions.start(input)
      keepAlive(operation.completion)
      return Response.json(operation.run, { status: 202 })
    }
    const [, encodedId, action] = path.split("/")
    const id = yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(RunId)(decodeURIComponent(encodedId ?? "")),
      catch: () =>
        new ExecutionFailure({ message: "Invalid execution request." }),
    })
    if (action === "cancel" && request.method === "POST")
      return Response.json(yield* executions.cancel(id))
    if (request.method === "GET" && !action) {
      const run = yield* executions.get(id)
      return run
        ? Response.json(run)
        : Response.json({ error: "Run not found." }, { status: 404 })
    }
    return new Response("Not found", { status: 404 })
  }).pipe(
    preserveFatal,
    Effect.catchTags({
      ExecutionFailure: (error) =>
        Effect.succeed(
          Response.json({ error: error.message }, { status: 409 })
        ),
      ExecutionStorageError: () =>
        Effect.succeed(
          Response.json(
            {
              error:
                "Execution is unavailable. Reload and inspect the saved run before starting another.",
            },
            { status: 409 }
          )
        ),
    })
  )
}
