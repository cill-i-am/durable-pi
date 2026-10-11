import { Effect, Schema } from "effect"
import { FileId, FileRejected, MAX_FILE_BYTES, MAX_VISION_BYTES } from "./files"
import { Workspace } from "./workspace"

const decode = <T>(schema: Schema.ConstraintDecoder<T>, value: unknown) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(value),
    catch: () => new FileRejected({ message: "Invalid file request." }),
  })
export async function boundedBytes(request: Request, maximum: number) {
  if (!request.body)
    throw new FileRejected({ message: "Choose a file to upload." })
  const reader = request.body.getReader(),
    parts: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.length
      if (length > maximum) {
        await reader.cancel()
        throw new FileRejected({
          message: "The request is too large. Files must be up to 8 MB.",
        })
      }
      parts.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return bytes
}
async function boundedForm(request: Request) {
  return new Response(
    await boundedBytes(request, MAX_FILE_BYTES + MAX_VISION_BYTES + 16_384),
    {
      headers: { "content-type": request.headers.get("content-type") ?? "" },
    }
  ).formData()
}
export function filesRequest(request: Request, path: string) {
  return Effect.gen(function* () {
    const workspace = yield* Workspace
    if (path === "files" && request.method === "GET")
      return Response.json({ files: yield* workspace.list() })
    if (path === "files/upload" && request.method === "POST") {
      const form = yield* Effect.tryPromise({
        try: () => boundedForm(request),
        catch: (cause) =>
          cause instanceof FileRejected
            ? cause
            : new FileRejected({ message: "Could not read the upload." }),
      })
      const id = yield* decode(FileId, form.get("id"))
      const file = form.get("file"),
        preview = form.get("vision")
      if (
        !(file instanceof File) ||
        (preview !== null && !(preview instanceof File))
      )
        return yield* new FileRejected({ message: "Choose a file to upload." })
      const bytes = new Uint8Array(
        yield* Effect.promise(() => file.arrayBuffer())
      )
      const vision =
        preview instanceof File
          ? new Uint8Array(yield* Effect.promise(() => preview.arrayBuffer()))
          : undefined
      const saved = yield* workspace.upload({
        id,
        name: file.name,
        mime: file.type,
        bytes,
        vision,
      })
      return Response.json(saved, { status: 201 })
    }
    const [base, rawId, action] = path.split("/")
    if (base !== "files" || !rawId)
      return new Response("Not found", { status: 404 })
    const id = yield* decode(FileId, rawId)
    if (request.method === "POST" && action === "extract")
      return Response.json(yield* workspace.retryExtraction(id), {
        status: 202,
      })
    if (request.method === "GET" && action === "video")
      return Response.json(yield* workspace.video(id))
    if (request.method === "GET" && action === "text") {
      const url = new URL(request.url)
      return Response.json(
        yield* workspace.readText(
          id,
          Number(url.searchParams.get("offset") ?? 0),
          Number(url.searchParams.get("limit") ?? 20_000)
        )
      )
    }
    if (
      request.method === "GET" &&
      (action === "content" || action === "vision")
    ) {
      const file = yield* workspace.content(id, action === "vision")
      const inline =
        action === "vision" ||
        (file.info.kind === "image" &&
          new URL(request.url).searchParams.get("download") !== "1")
      return new Response(file.body, {
        headers: {
          "content-type": file.mime,
          "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.info.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
          "referrer-policy": "no-referrer",
        },
      })
    }
    if (
      request.method === "POST" &&
      (action === "trash" || action === "restore")
    )
      return Response.json(yield* workspace.trash(id, action === "trash"))
    if (request.method === "POST" && action === "rename") {
      const raw = yield* Effect.tryPromise({
        try: async () => {
          const text = new TextDecoder().decode(
            await boundedBytes(request, 2048)
          )
          return JSON.parse(text)
        },
        catch: () => new FileRejected({ message: "Invalid file name." }),
      })
      const { name } = yield* decode(
        Schema.Struct({ name: Schema.String }),
        raw
      )
      return Response.json(yield* workspace.rename(id, name))
    }
    return new Response("Not found", { status: 404 })
  }).pipe(
    Effect.catchTags({
      WorkspaceReadOnly: () =>
        Effect.succeed(
          Response.json(
            { error: "Restore this bot before changing its files." },
            { status: 409 }
          )
        ),
      FileNotFound: () =>
        Effect.succeed(
          Response.json(
            { error: "File not found. It may have been moved to Trash." },
            { status: 404 }
          )
        ),
      FileRejected: (cause) =>
        Effect.succeed(
          Response.json({ error: cause.message }, { status: 400 })
        ),
      WorkspaceUnavailable: () =>
        Effect.succeed(
          Response.json(
            {
              error:
                "File storage is temporarily unavailable. Retry the same upload.",
            },
            { status: 503 }
          )
        ),
    })
  )
}
