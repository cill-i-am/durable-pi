import { Effect, Schema } from "effect"

import { jsonRequest } from "../../shared/http"
import { nativeOperation } from "../../shared/interop"
import { exportFileBytes } from "../../workspace/adapters/export"
import { workspaceBytes } from "../../workspace/adapters/stream"
import {
  MAX_ATTACHMENTS,
  MAX_FILE_BYTES,
  type Upload,
} from "../../workspace/files"
import type { Workspace } from "../../workspace/workspace"
import { EMAIL_MAX_RAW, EmailRejected, IncomingEmail } from "../contracts"

const invalid = () =>
  new EmailRejected({
    message:
      "Invalid email attachments. Use up to four files, 8 MiB each and 20 MiB total.",
  })

/** The private service binding carries binary parts without JSON/base64 copies. */
export const incomingEmailRequest = (request: Request) =>
  Effect.gen(function* () {
    if (
      !request.headers.get("content-type")?.startsWith("multipart/form-data")
    ) {
      const input = yield* jsonRequest(request, IncomingEmail, 160_000, invalid)
      if (input.files?.length) return yield* invalid()
      return { input, attachments: [] as Upload[] }
    }
    if (!request.body) return yield* invalid()
    const raw = yield* workspaceBytes(
      request.body,
      EMAIL_MAX_RAW + 16_384,
      invalid
    ).pipe(Effect.mapError(invalid))
    const form = yield* nativeOperation(
      () =>
        new Response(new Uint8Array(raw), {
          headers: { "content-type": request.headers.get("content-type")! },
        }).formData(),
      invalid
    )
    const input = yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(IncomingEmail)(
          JSON.parse(String(form.get("message")))
        ),
      catch: invalid,
    })
    const parts = form.getAll("attachment")
    if (
      parts.length > MAX_ATTACHMENTS ||
      parts.length !== (input.files?.length ?? 0)
    )
      return yield* invalid()
    const attachments: Upload[] = []
    for (const [index, part] of parts.entries()) {
      if (typeof part === "string" || part.size > MAX_FILE_BYTES)
        return yield* invalid()
      const bytes = yield* nativeOperation(() => part.arrayBuffer(), invalid)
      attachments.push({
        id: input.files![index]!,
        name: part.name,
        mime: part.type,
        bytes: new Uint8Array(bytes),
      })
    }
    return { input, attachments }
  })

/** Export one frozen delivery part through the shared private-file reader. */
export const emailAttachments = (
  workspace: typeof Workspace.Service,
  ids: readonly string[]
) =>
  Effect.gen(function* () {
    const attachments: EmailAttachment[] = []
    for (const id of ids) {
      const exported = yield* exportFileBytes(workspace, id, 16 * 1024 * 1024)
      attachments.push({
        content: new Uint8Array(exported.bytes).buffer,
        filename: exported.name,
        type: exported.mime,
        disposition: "attachment",
      })
    }
    return attachments
  })
