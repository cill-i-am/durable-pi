import { Effect, Schema } from "effect"
import { boundedBytes } from "../workspace/http"
import { CommandInput, TerminalFailure } from "./contracts"
import type { Terminal } from "./terminal"

export function terminalRequest(
  terminal: Terminal,
  request: Request,
  path: string,
  keepAlive: (task: Promise<unknown>) => void
) {
  return Effect.gen(function* () {
    if (path === "terminal" && request.method === "GET")
      return Response.json(terminal.state())
    if (path === "terminal/cleanup" && request.method === "POST") {
      const completion = yield* Effect.try(() => terminal.recover())
      keepAlive(completion)
      return Response.json({ ok: true })
    }
    if (path === "terminal/run" && request.method === "POST") {
      const input = yield* Effect.tryPromise(() =>
        boundedBytes(request, 128000).then((bytes) =>
          Schema.decodeUnknownSync(CommandInput)(
            JSON.parse(new TextDecoder().decode(bytes))
          )
        )
      )
      const operation = yield* terminal.start(input)
      keepAlive(operation.completion)
      return Response.json(operation.run, { status: 202 })
    }
    const [, encodedId, action] = path.split("/")
    const id = yield* Effect.try(() => decodeURIComponent(encodedId ?? ""))
    if (action === "cancel" && request.method === "POST")
      return Response.json((yield* terminal.cancel(id)) ?? { ok: true })
    if (!action && request.method === "GET") {
      const run = terminal.repository.get(id)
      return run
        ? Response.json(run)
        : new Response("Not found", { status: 404 })
    }
    return new Response("Not found", { status: 404 })
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed(
        Response.json(
          {
            error:
              cause instanceof TerminalFailure
                ? cause.message
                : "The terminal request failed.",
          },
          { status: 409 }
        )
      )
    )
  )
}
