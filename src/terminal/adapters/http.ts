import { Effect, Option, Schema } from "effect"

import { preserveFatal } from "../../shared/effect"
import { nativeOperation } from "../../shared/interop"
import { nativeBytes } from "../../shared/stream"
import { inspectFile, FileRejected } from "../../workspace/files"
import { CommandInput, TerminalNetworkPolicy } from "../contracts"
import type { TerminalOperationError, TerminalOperations } from "../terminal"
import {
  ImportFile,
  ExportFile,
  exportPlan,
  MAX_TRANSFER_BYTES,
} from "../transfers"

class TerminalRequestInvalid extends Schema.TaggedError<TerminalRequestInvalid>()(
  "TerminalRequestInvalid",
  {}
) {}
const invalid = () => new TerminalRequestInvalid()
const decode = <T>(schema: Schema.ConstraintDecoder<T>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    preserveFatal,
    Effect.mapError(invalid)
  )
const bytes = (request: Request, maximum: number) =>
  request.body
    ? nativeBytes(request.body, maximum, invalid, invalid)
    : Effect.fail(invalid())
const json = <T>(
  request: Request,
  schema: Schema.ConstraintDecoder<T>,
  maximum: number
) =>
  bytes(request, maximum).pipe(
    Effect.flatMap((raw) =>
      decode(Schema.fromJsonString(schema), new TextDecoder().decode(raw))
    )
  )
const Authority = Schema.Struct({
  revision: TerminalNetworkPolicy.fields.revision,
  active: Schema.Boolean,
  revokeThrough: Schema.optional(TerminalNetworkPolicy.fields.revision),
})

export function terminalRequest(
  terminal: TerminalOperations,
  request: Request,
  path: string,
  keepAlive: (task: Effect.Effect<void, TerminalOperationError>) => void
): Effect.Effect<Response> {
  return Effect.gen(function* () {
    yield* Effect.yieldNow
    if (path === "terminal" && request.method === "GET")
      return Response.json(yield* terminal.state())
    if (request.method === "POST") {
      const response = yield* terminalPost(terminal, request, path, keepAlive)
      if (response) return response
    }
    const parts = path.split("/")
    if (parts[1] === "session" && parts.length === 4) {
      const response = yield* sessionRequest(terminal, request, parts)
      if (response) return response
    }
    const [, encodedId, action] = parts
    const id = yield* Effect.try({
      try: () => decodeURIComponent(encodedId ?? ""),
      catch: invalid,
    })
    if (action === "file" && request.method === "GET") {
      const run = yield* terminal.get(id)
      if (run?.transfer?.kind !== "export")
        return new Response("Not found", { status: 404 })
      const payload = yield* terminal.exportedFile(id),
        name = run.transfer.name
      const mime = yield* Effect.sync(() => {
        try {
          return inspectFile({
            id,
            name,
            mime: /\.mp4$/i.test(name)
              ? "video/mp4"
              : /\.webm$/i.test(name)
                ? "video/webm"
                : "",
            bytes: payload,
          }).mime
        } catch (cause) {
          if (Option.isSome(Schema.decodeUnknownOption(FileRejected)(cause)))
            return "application/octet-stream"
          throw cause
        }
      })
      return new Response(payload.slice().buffer, {
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
      return Response.json(yield* terminal.cancel(id))
    if (!action && request.method === "GET") {
      const run = yield* terminal.get(id)
      return run
        ? Response.json(run)
        : new Response("Not found", { status: 404 })
    }
    return new Response("Not found", { status: 404 })
  }).pipe(
    Effect.scoped,
    preserveFatal,
    Effect.catchTags({
      TerminalFailure: (error) =>
        Effect.succeed(
          Response.json({ error: error.message }, { status: 409 })
        ),
      TerminalRequestInvalid: () =>
        Effect.succeed(
          Response.json(
            { error: "The terminal request failed." },
            { status: 409 }
          )
        ),
      TerminalStorageError: () =>
        Effect.succeed(
          Response.json(
            { error: "The terminal request failed." },
            { status: 409 }
          )
        ),
      TerminalRuntimeError: () =>
        Effect.succeed(
          Response.json(
            { error: "The terminal request failed." },
            { status: 409 }
          )
        ),
    })
  )
}

const terminalPost = Effect.fn("Terminal.postRequest")(function* (
  terminal: TerminalOperations,
  request: Request,
  path: string,
  keepAlive: (task: Effect.Effect<void, TerminalOperationError>) => void
) {
  if (path === "authority") {
    const input = yield* json(request, Authority, 4096)
    yield* terminal.configure(input.revision, input.active, input.revokeThrough)
    return Response.json({ ok: true })
  }
  if (path === "terminal/network")
    return Response.json(
      yield* terminal.configureNetwork(
        yield* json(request, TerminalNetworkPolicy, 4096)
      )
    )
  if (path === "terminal/import") {
    const raw = yield* bytes(request, MAX_TRANSFER_BYTES + 16384)
    const form = yield* nativeOperation(
      () =>
        new Response(new Uint8Array(raw), {
          headers: {
            "content-type": request.headers.get("content-type") ?? "",
          },
        }).formData(),
      invalid
    )
    const file = form.get("file")
    if (file === null || typeof file === "string") return yield* invalid()
    const input = yield* decode(ImportFile, {
      id: form.get("id"),
      fileId: form.get("fileId"),
      name: file.name,
    })
    const payload = new Uint8Array(
      yield* nativeOperation(() => file.arrayBuffer(), invalid)
    )
    const operation = yield* terminal.startImport(input, payload)
    keepAlive(operation.completion)
    return Response.json(operation.run, { status: 202 })
  }
  if (path === "terminal/export") {
    const input = yield* json(request, ExportFile, 4096)
    const plan = yield* Effect.try({
      try: () => exportPlan(input),
      catch: invalid,
    })
    const operation = yield* terminal.startTransfer(input.id, plan)
    keepAlive(operation.completion)
    return Response.json(operation.run, { status: 202 })
  }
  if (path === "terminal/session") {
    const input = yield* json(
      request,
      Schema.Struct({ id: CommandInput.fields.id }),
      1024
    )
    const operation = yield* terminal.startSession(input.id)
    keepAlive(operation.completion)
    return Response.json(operation.run, { status: 202 })
  }
  if (path === "terminal/cleanup") {
    keepAlive(terminal.recover())
    return Response.json({ ok: true })
  }
  if (path === "terminal/run") {
    const operation = yield* terminal.start(
      yield* json(request, CommandInput, 128000)
    )
    keepAlive(operation.completion)
    return Response.json(operation.run, { status: 202 })
  }
})

const sessionRequest = Effect.fn("Terminal.sessionRequest")(function* (
  terminal: TerminalOperations,
  request: Request,
  parts: string[]
) {
  const id = yield* Effect.try({
    try: () => decodeURIComponent(parts[2]!),
    catch: invalid,
  })
  const session = yield* terminal.session(id),
    action = parts[3]
  if (action === "renew" && request.method === "POST") {
    yield* session.renew()
    return Response.json(session.state())
  }
  if (action === "save" && request.method === "POST") {
    yield* session.save()
    return Response.json({ ok: true })
  }
  if (
    action === "socket" &&
    request.method === "GET" &&
    request.headers.get("upgrade") === "websocket"
  )
    return yield* session.connect(request)
})
