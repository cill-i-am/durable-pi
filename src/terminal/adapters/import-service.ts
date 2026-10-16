import { Effect, Schema } from "effect"

import { preserveFatal } from "../../shared/effect"
import { nativeResponse } from "../../shared/interop"
import { nativeBytes } from "../../shared/stream"
import { CommandRun } from "../contracts"
import { TerminalRuntimeError } from "../runtime"
import type { TerminalImports } from "../workspace-import"

const RECEIPT_BYTES = 512 * 1024
/** The maximum command/output plus JSON escaping fits this receipt budget. */
export function terminalImports(
  service: { fetch: (request: Request) => Promise<Response> },
  identity: string
): TerminalImports {
  const failed = (operation: string) => (cause: unknown) =>
    new TerminalRuntimeError({ operation, cause })
  const decode = (response: Response) =>
    Effect.gen(function* () {
      if (!response.body)
        return yield* failed("read transfer receipt")("Missing body")
      const bytes = yield* nativeBytes(
        response.body,
        RECEIPT_BYTES,
        () => failed("read transfer receipt")("Unreadable body"),
        () => failed("read transfer receipt")("Receipt limit")
      )
      return yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(CommandRun)
      )(new TextDecoder().decode(bytes)).pipe(
        preserveFatal,
        Effect.mapError(failed("decode transfer receipt"))
      )
    })
  return {
    find: (id) =>
      Effect.scoped(
        Effect.gen(function* () {
          const response = yield* nativeResponse(
            (signal) =>
              service.fetch(
                new Request(
                  `https://terminal.internal/${identity}/terminal/${encodeURIComponent(id)}`,
                  { signal }
                )
              ),
            failed("find transfer receipt")
          )
          if (response.status === 404) return null
          if (!response.ok)
            return yield* failed("find transfer receipt")(response.status)
          return yield* decode(response)
        })
      ),
    copy: (input, content, bytes) =>
      Effect.scoped(
        Effect.gen(function* () {
          const form = new FormData()
          form.set("id", input.id)
          form.set("fileId", input.fileId)
          form.set(
            "file",
            new Blob([new Uint8Array(bytes)], { type: content.mime }),
            content.info.name
          )
          const response = yield* nativeResponse(
            (signal) =>
              service.fetch(
                new Request(
                  `https://terminal.internal/${identity}/terminal/import`,
                  { method: "POST", body: form, signal }
                )
              ),
            failed("copy workspace file")
          )
          if (response.status === 409) return { kind: "conflict" as const }
          if (!response.ok)
            return yield* failed("copy workspace file")(response.status)
          return { kind: "accepted" as const, run: yield* decode(response) }
        })
      ),
  }
}
