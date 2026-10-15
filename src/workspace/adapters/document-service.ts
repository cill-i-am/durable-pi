import { Effect, Schema } from "effect"
import {
  DocumentUnreadable,
  ExtractedDocument,
  PDF_TEXT_LIMIT,
  type ExtractDocument,
} from "../documents"
import { WorkspaceUnavailable } from "../files"
import { workspaceResponse } from "./interop"
import { workspaceBytes } from "./stream"

type DocumentService = { fetch: (request: Request) => Promise<Response> }
const unreadable = Schema.Struct({
  reason: Schema.Literals(["encrypted", "invalid"]),
})
// JSON can escape each text character as six bytes.
const DOCUMENT_RESULT_BYTES = PDF_TEXT_LIMIT * 6 + 8192
export const documentService =
  (service: DocumentService): ExtractDocument =>
  (bytes) =>
    Effect.scoped(
      Effect.gen(function* () {
        const response = yield* workspaceResponse((signal) =>
          service.fetch(
            new Request("https://documents/pdf", {
              method: "POST",
              body: new Uint8Array(bytes),
              signal,
            })
          )
        )
        if (!response.ok && response.status !== 422)
          return yield* new WorkspaceUnavailable()
        if (!response.body) return yield* new WorkspaceUnavailable()
        const body = yield* workspaceBytes(
          response.body,
          response.status === 422 ? 8192 : DOCUMENT_RESULT_BYTES,
          () => new WorkspaceUnavailable()
        )
        // This is our parser's protocol: malformed success/error records are defects.
        const value: unknown = JSON.parse(new TextDecoder().decode(body))
        if (response.status === 422)
          return yield* new DocumentUnreadable(
            Schema.decodeUnknownSync(unreadable)(value)
          )
        return Schema.decodeUnknownSync(ExtractedDocument)(value)
      })
    )
