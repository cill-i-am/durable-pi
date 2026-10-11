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
    if (path === "terminal/session" && request.method === "POST") {
      const raw = yield* Effect.tryPromise(() =>
        boundedBytes(request, 1024).then((bytes) =>
          JSON.parse(new TextDecoder().decode(bytes))
        )
      )
      const input = yield* Effect.try(() =>
        Schema.decodeUnknownSync(Schema.Struct({ id: CommandInput.fields.id }))(
          raw
        )
      )
      const operation = yield* terminal.startSession(input.id)
      keepAlive(operation.completion)
      return Response.json(operation.run, { status: 202 })
    }
    const sessionParts = path.split("/")
    if (sessionParts[1] === "session" && sessionParts.length === 4) {
      const session = yield* Effect.try(() =>
        terminal.session(decodeURIComponent(sessionParts[2]!))
      )
      const action = sessionParts[3]
      if (action === "renew" && request.method === "POST") {
        yield* Effect.try(() => session.renew())
        return Response.json(session.state())
      }
      if (action === "save" && request.method === "POST") {
        yield* Effect.try(() => session.save())
        return Response.json({ ok: true })
      }
      if (
        action === "socket" &&
        request.method === "GET" &&
        request.headers.get("upgrade") === "websocket"
      )
        return yield* Effect.tryPromise(() => session.connect(request))
    }
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
