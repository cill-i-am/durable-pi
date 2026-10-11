import { Effect, Schema } from "effect"
import { boundedBytes } from "../workspace/http"
import { RunInput, RunId, ExecutionFailure } from "./contracts"
import type { Executions } from "./execution"

export function executionRequest(
  executions: Executions,
  request: Request,
  path: string,
  keepAlive: (task: Promise<unknown>) => void
) {
  return Effect.gen(function* () {
    if (path === "execution" && request.method === "GET")
      return Response.json({ runs: executions.repository.list() })
    if (path === "execution/run" && request.method === "POST") {
      const input = yield* Effect.tryPromise(() =>
        boundedBytes(request, 256000).then((bytes) =>
          Schema.decodeUnknownSync(RunInput)(
            JSON.parse(new TextDecoder().decode(bytes))
          )
        )
      )
      const operation = yield* executions.start(input)
      keepAlive(operation.completion)
      return Response.json(operation.run, { status: 202 })
    }
    const [, encodedId, action] = path.split("/")
    const id = yield* Effect.try(() =>
      Schema.decodeUnknownSync(RunId)(decodeURIComponent(encodedId ?? ""))
    )
    if (action === "cancel" && request.method === "POST")
      return Response.json(yield* executions.cancel(id))
    if (request.method === "GET" && !action) {
      const run = executions.repository.get(id)
      return run
        ? Response.json(run)
        : Response.json({ error: "Run not found." }, { status: 404 })
    }
    return new Response("Not found", { status: 404 })
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed(
        Response.json(
          {
            error:
              cause instanceof ExecutionFailure
                ? cause.message
                : "Invalid execution request.",
          },
          { status: 409 }
        )
      )
    )
  )
}
