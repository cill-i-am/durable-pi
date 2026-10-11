import { Effect, Schema } from "effect"
import { boundedBytes } from "../workspace/http"
import {
  CommandInput,
  TerminalFailure,
  TerminalNetworkPolicy,
} from "./contracts"
import {
  ImportFile,
  ExportFile,
  importPlan,
  exportPlan,
  MAX_TRANSFER_BYTES,
} from "./transfers"
import { inspectFile } from "../workspace/files"
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
    if (path === "terminal/network" && request.method === "POST") {
      const input = yield* Effect.tryPromise(async () =>
        Schema.decodeUnknownSync(TerminalNetworkPolicy)(
          JSON.parse(
            new TextDecoder().decode(await boundedBytes(request, 4096))
          )
        )
      )
      return Response.json(
        yield* Effect.try(() => terminal.configureNetwork(input))
      )
    }
    if (path === "terminal/import" && request.method === "POST") {
      const form = yield* Effect.tryPromise(async () =>
        new Response(await boundedBytes(request, MAX_TRANSFER_BYTES + 16384), {
          headers: {
            "content-type": request.headers.get("content-type") ?? "",
          },
        }).formData()
      )
      const file = form.get("file")
      if (!(file instanceof File))
        return yield* new TerminalFailure({ message: "Choose a file to copy." })
      const input = yield* Effect.try(() =>
        Schema.decodeUnknownSync(ImportFile)({
          id: form.get("id"),
          fileId: form.get("fileId"),
          name: file.name,
        })
      )
      const bytes = new Uint8Array(
        yield* Effect.promise(() => file.arrayBuffer())
      )
      const plan = yield* Effect.tryPromise(() => importPlan(input, bytes))
      const operation = yield* terminal.startTransfer(input.id, plan, bytes)
      keepAlive(operation.completion)
      return Response.json(operation.run, { status: 202 })
    }
    if (path === "terminal/export" && request.method === "POST") {
      const input = yield* Effect.tryPromise(async () =>
        Schema.decodeUnknownSync(ExportFile)(
          JSON.parse(
            new TextDecoder().decode(await boundedBytes(request, 4096))
          )
        )
      )
      const plan = yield* Effect.try(() => exportPlan(input))
      const operation = yield* terminal.startTransfer(input.id, plan)
      keepAlive(operation.completion)
      return Response.json(operation.run, { status: 202 })
    }
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
    if (action === "file" && request.method === "GET") {
      const run = terminal.repository.get(id)
      if (run?.transfer?.kind !== "export")
        return new Response("Not found", { status: 404 })
      const bytes = yield* Effect.tryPromise(() => terminal.exportedFile(id))
      const name = run.transfer.name
      // Downloads preserve arbitrary regular-file bytes. The Files library applies
      // its stricter text/image validation when the owner adds the export there.
      let mime = "application/octet-stream"
      try {
        mime = inspectFile({
          id,
          name,
          mime: /\.mp4$/i.test(name)
            ? "video/mp4"
            : /\.webm$/i.test(name)
              ? "video/webm"
              : "",
          bytes,
        }).mime
      } catch {}
      return new Response(bytes.slice().buffer, {
        headers: {
          "content-type": mime,
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`,
          "cache-control": "private, no-store",
          "content-security-policy": "default-src 'none'; sandbox",
          "x-content-type-options": "nosniff",
        },
      })
    }
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
