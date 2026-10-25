import { Cause, Schema } from "effect"

export const UploadRequest = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  attach: Schema.Boolean,
  file: Schema.declare(
    (value): value is File =>
      typeof File !== "undefined" && value instanceof File
  ),
})
export type UploadRequest = typeof UploadRequest.Type
export const UploadAttempt = Schema.Struct({
  ...UploadRequest.fields,
  status: Schema.Literals(["uploading", "failed"]),
  error: Schema.optionalKey(Schema.String),
})
export type UploadAttempt = typeof UploadAttempt.Type
export type FileAction = "trash" | "restore" | "rename" | "extract"

export function fileFailure(error: unknown, fallback: string): string {
  if (Cause.isCause(error)) {
    const reason = error.reasons.find(
      (value) => value._tag === "Fail" || value._tag === "Die"
    )
    return reason?._tag === "Fail"
      ? fileFailure(reason.error, fallback)
      : reason?._tag === "Die"
        ? fileFailure(reason.defect, fallback)
        : fallback
  }
  return error instanceof Error ? error.message : fallback
}
