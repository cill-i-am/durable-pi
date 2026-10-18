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

/** Only files explicitly registered for this reply are eligible for transport.
 * The user authorized these selected files to their enrolled Gmail inbox. */
export const emailReplyFiles = (
  workspace: typeof Workspace.Service,
  turnId: string,
  reviewUrl: string
) =>
  Effect.gen(function* () {
    const files = yield* workspace.replyFiles(turnId)
    const maximum = 16 * 1024 * 1024
    if (files.reduce((total, file) => total + file.size, 0) > maximum)
      return {
        attachments: [] as EmailAttachment[],
        suffix: `\n\nThese files exceed the email attachment limit. Open them in Pi:\n${files.map((file) => `${file.name}: ${reviewUrl}/files/${file.id}`).join("\n")}`,
      }
    const attachments: EmailAttachment[] = []
    for (const file of files) {
      const exported = yield* exportFileBytes(workspace, file.id, maximum)
      attachments.push({
        content: new Uint8Array(exported.bytes).buffer,
        filename: exported.name,
        type: exported.mime,
        disposition: "attachment",
      })
    }
    return { attachments, suffix: "" }
  })
