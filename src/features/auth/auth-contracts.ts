import { Cause, Schema } from "effect"

export class AuthIssue extends Schema.TaggedError<AuthIssue>()("AuthIssue", {
  message: Schema.String,
  code: Schema.optional(Schema.String),
}) {}
export const Secret = Schema.Redacted(
  Schema.Record(Schema.String, Schema.String),
  { disallowJsonEncode: true }
)
export type Secret = typeof Secret.Type
export function authMessage(cause: Cause.Cause<unknown>, fallback: string) {
  const reason = cause.reasons.find((value) => value._tag === "Fail")
  const value = reason?._tag === "Fail" ? reason.error : undefined
  return Schema.is(AuthIssue)(value)
    ? value
    : new AuthIssue({ message: fallback })
}
