import { Effect, Schema } from "effect"

import { preserveFatal } from "../../shared/effect"
import {
  FileId,
  FileRejected,
  MAX_FILE_BYTES,
  MAX_VISION_BYTES,
} from "../files"
import { Workspace } from "../workspace"
import { fileDownload, type FileBodyRunner } from "./download"
import { workspaceNativeOperation } from "./interop"
import { workspaceBytes } from "./stream"

const decode = <T>(schema: Schema.ConstraintDecoder<T>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      () => new FileRejected({ message: "Invalid file request." })
    )
  )
export const workspaceRequestBytes = (request: Request, maximum: number) =>
  request.body
    ? workspaceBytes(
        request.body,
        maximum,
        () =>
          new FileRejected({
            message: "The request is too large. Files must be up to 8 MB.",
          })
      ).pipe(
        preserveFatal,
        Effect.catchTag("WorkspaceUnavailable", () =>
          Effect.fail(
            new FileRejected({ message: "Could not read the upload." })
          )
        )
      )
    : Effect.fail(new FileRejected({ message: "Choose a file to upload." }))
export function filesRequest(
  request: Request,
  path: string,
  runBody?: FileBodyRunner
): Effect.Effect<Response, never, Workspace> {
  return Effect.gen(function* () {
    const workspace = yield* Workspace
    if (path === "files" && request.method === "GET")
      return Response.json({ files: yield* workspace.list() })
    if (path === "files/upload" && request.method === "POST") {
      return yield* uploadFile(workspace, request)
    }
    const [base, rawId, action] = path.split("/")
    if (base !== "files" || !rawId)
      return new Response("Not found", { status: 404 })
    const id = yield* decode(FileId, rawId)
    const route = `${request.method} ${action}`
    if (route === "POST extract")
      return Response.json(yield* workspace.retryExtraction(id), {
        status: 202,
      })
    if (route === "GET video") return Response.json(yield* workspace.video(id))
    if (route === "GET text") {
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
      return yield* fileDownload(
        workspace.content(id, action === "vision"),
        request,
        (file) =>
          action === "vision" ||
          (file.info.kind === "image" &&
            new URL(request.url).searchParams.get("download") !== "1"),
        runBody
      )
    }
    if (
      request.method === "POST" &&
      (action === "trash" || action === "restore")
    )
      return Response.json(yield* workspace.trash(id, action === "trash"))
    if (route === "POST rename") {
      const bytes = yield* workspaceRequestBytes(request, 2048).pipe(
        preserveFatal,
        Effect.mapError(
          () => new FileRejected({ message: "Invalid file name." })
        )
      )
      const raw = yield* Effect.try({
        try: (): unknown => JSON.parse(new TextDecoder().decode(bytes)),
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
    preserveFatal,
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

const uploadFile = Effect.fn("Workspace.uploadRequest")(function* (
  workspace: typeof Workspace.Service,
  request: Request
) {
  const raw = yield* workspaceRequestBytes(
    request,
    MAX_FILE_BYTES + MAX_VISION_BYTES + 16_384
  )
  const form = yield* workspaceNativeOperation(() =>
    new Response(new Uint8Array(raw), {
      headers: {
        "content-type": request.headers.get("content-type") ?? "",
      },
    }).formData()
  ).pipe(
    Effect.mapError(
      () => new FileRejected({ message: "Could not read the upload." })
    )
  )
  const id = yield* decode(FileId, form.get("id"))
  const file = form.get("file"),
    preview = form.get("vision")
  if (
    !(file instanceof File) ||
    (preview !== null && !(preview instanceof File))
  )
    return yield* new FileRejected({ message: "Choose a file to upload." })
  const bytes = new Uint8Array(
    yield* workspaceNativeOperation(() => file.arrayBuffer())
  )
  const vision =
    preview instanceof File
      ? new Uint8Array(
          yield* workspaceNativeOperation(() => preview.arrayBuffer())
        )
      : undefined
  const saved = yield* workspace.upload({
    id,
    name: file.name,
    mime: file.type,
    bytes,
    vision,
  })
  return Response.json(saved, { status: 201 })
})
