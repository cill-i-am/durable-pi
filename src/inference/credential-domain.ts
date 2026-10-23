import { Effect, Equal, Schema } from "effect"

import type { CredentialRotation } from "./credential-rotation.machine"

const Secret = Schema.RedactedFromValue(
  Schema.String.check(Schema.isMinLength(1))
)
export const OAuthCredential = Schema.Struct({
  type: Schema.Literal("oauth"),
  access: Secret,
  refresh: Secret,
  expires: Schema.Number.check(Schema.isFinite()),
  clientId: Schema.String.check(Schema.isMinLength(1)),
  connectionId: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  identity: Schema.optional(
    Schema.Struct({
      issuer: Schema.Literal("https://auth.openai.com"),
      subject: Schema.String.check(Schema.isMinLength(1)),
      email: Schema.String.check(Schema.isMinLength(1)),
    })
  ),
})
export type OAuthCredential = typeof OAuthCredential.Type
export const ModelCredential = Schema.Union([
  OAuthCredential,
  Schema.Struct({ type: Schema.Literal("api_key"), key: Secret }),
])
export type ModelCredential = typeof ModelCredential.Type
export class CredentialUnavailable extends Schema.TaggedError<CredentialUnavailable>()(
  "CredentialUnavailable",
  { message: Schema.String }
) {}
export class CredentialStorageError extends Schema.TaggedError<CredentialStorageError>()(
  "CredentialStorageError",
  {}
) {}
export class CredentialRefreshError extends Schema.TaggedError<CredentialRefreshError>()(
  "CredentialRefreshError",
  {
    reason: Schema.Literals(["rejected", "unavailable", "invalid", "timeout"]),
    message: Schema.String,
  }
) {}
export class CredentialCorrupt extends Error {
  readonly _tag = "CredentialCorrupt"
  constructor() {
    super("The stored model credential is invalid. Reconnect the account.")
  }
}
export type CredentialRecord =
  | {
      value: ModelCredential
      seedCurrent: true
      rotation: CredentialRotation
      refreshing: boolean
    }
  | { seedCurrent: false; rotation: CredentialRotation; refreshing: boolean }

export interface CredentialLedger {
  atomic: <TValue, TError, TRequirements>(
    body: () => Effect.Effect<TValue, TError, TRequirements>
  ) => Effect.Effect<TValue, TError | CredentialStorageError, TRequirements>
  read: (
    provider: string
  ) => Effect.Effect<CredentialRecord | undefined, CredentialError>
  seed: () => Effect.Effect<ModelCredential | undefined>
  put: (
    provider: string,
    value: ModelCredential,
    rotation?: CredentialRotation
  ) => Effect.Effect<void, CredentialStorageError>
  install: (
    provider: string,
    value: ModelCredential
  ) => Effect.Effect<void, CredentialStorageError>
}
export type CredentialError = CredentialUnavailable | CredentialStorageError
export type CredentialRefresh = (
  current: OAuthCredential
) => Effect.Effect<OAuthCredential, CredentialRefreshError>
export const credentialNeedsRefresh = (value: ModelCredential, now: number) =>
  value.type === "oauth" && value.expires <= now + 300_000
export function sameCredential(a: ModelCredential, b: ModelCredential) {
  return a.type === "oauth" && b.type === "oauth"
    ? a.connectionId === b.connectionId &&
        a.expires === b.expires &&
        a.clientId === b.clientId &&
        Equal.equals(a.access, b.access) &&
        Equal.equals(a.refresh, b.refresh)
    : a.type === "api_key" && b.type === "api_key" && Equal.equals(a.key, b.key)
}

export class ChatGPTSignInError extends Schema.TaggedError<ChatGPTSignInError>()(
  "ChatGPTSignInError",
  { message: Schema.String }
) {}
export type AccountCredentialError = CredentialError | ChatGPTSignInError
