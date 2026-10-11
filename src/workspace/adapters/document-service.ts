import { Effect, Schema } from "effect"
import {
  DocumentUnreadable,
  ExtractedDocument,
  type ExtractDocument,
} from "../documents"
import { WorkspaceUnavailable } from "../files"

type DocumentService = { fetch: (request: Request) => Promise<Response> }
export const documentService =
  (service: DocumentService): ExtractDocument =>
  (bytes) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await service.fetch(
          new Request("https://documents/pdf", {
            method: "POST",
            body: new Uint8Array(bytes),
            signal,
          })
        )
        if (response.status === 422) {
          const error = Schema.decodeUnknownSync(
            Schema.Struct({ reason: Schema.Literals(["encrypted", "invalid"]) })
          )(await response.json())
          throw new DocumentUnreadable(error)
        }
        if (!response.ok) throw new WorkspaceUnavailable()
        return Schema.decodeUnknownSync(ExtractedDocument)(
          await response.json()
        )
      },
      catch: (cause) =>
        cause instanceof DocumentUnreadable
          ? cause
          : new WorkspaceUnavailable(),
    })
