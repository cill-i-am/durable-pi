import type { Effect} from "effect";
import { Schema } from "effect"
import type { WorkspaceUnavailable } from "./files"

export const PDF_PAGE_LIMIT = 50
export const PDF_TEXT_LIMIT = 200_000
export const ExtractedDocument = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(PDF_TEXT_LIMIT)),
  pages: Schema.Number,
  readPages: Schema.Number,
  truncated: Schema.Boolean,
})
export type ExtractedDocument = typeof ExtractedDocument.Type
export class DocumentUnreadable extends Schema.TaggedError<DocumentUnreadable>()(
  "DocumentUnreadable",
  { reason: Schema.Literals(["encrypted", "invalid"]) }
) {}
export type ExtractDocument = (
  bytes: Uint8Array
) => Effect.Effect<ExtractedDocument, DocumentUnreadable | WorkspaceUnavailable>
