import { Clock, Effect, Redacted, Schema } from "effect"
import { observeCleanup } from "../../shared/effect"
import { nativeResponse } from "../../shared/interop"
import { nativeBytes } from "../../shared/stream"
import { CredentialRefreshError, OAuthCredential } from "../credentials"

const TokenResponse = Schema.Struct({
  access_token: Schema.String.check(Schema.isMinLength(1)),
  refresh_token: Schema.String.check(Schema.isMinLength(1)),
  expires_in: Schema.Number.check(Schema.isFinite()),
  scope: Schema.String,
})
const Denied = Schema.Struct({
  access_token: Schema.optional(Schema.Never),
  refresh_token: Schema.optional(Schema.Never),
  error: Schema.Literals([
    "invalid_request",
    "invalid_client",
    "invalid_grant",
    "unauthorized_client",
    "unsupported_grant_type",
    "invalid_scope",
  ]),
})
const uncertain = () =>
  new CredentialRefreshError({
    reason: "unavailable",
    message:
      "ChatGPT credential refresh could not be confirmed. Reconnect the account.",
  })
export const refreshOAuth = Effect.fn("Inference.refreshOAuth")(
  (credential: OAuthCredential, transport: typeof fetch = fetch) =>
    observeCleanup(
      Effect.scoped(
        Effect.gen(function* () {
          const response = yield* nativeResponse(
            (signal) =>
              transport("https://auth.openai.com/api/accounts/oauth/token", {
                method: "POST",
                redirect: "manual",
                signal,
                headers: {
                  accept: "application/json",
                  "content-type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams({
                  grant_type: "refresh_token",
                  client_id: credential.clientId,
                  refresh_token: Redacted.value(credential.refresh),
                  resource: "https://api.openai.com/v1",
                }),
              }),
            uncertain
          )
          if (!response.ok) {
            let confirmed = false
            if (response.body) {
              const bytes = yield* nativeBytes(
                response.body,
                65_536,
                uncertain,
                uncertain
              )
              const denied = yield* Schema.decodeUnknownEffect(
                Schema.fromJsonString(Denied)
              )(new TextDecoder().decode(bytes)).pipe(Effect.result)
              confirmed =
                (response.status === 400 || response.status === 401) &&
                denied._tag === "Success"
            }
            return yield* new CredentialRefreshError({
              reason: confirmed ? "rejected" : "unavailable",
              message:
                "ChatGPT authorization expired. Reconnect with pnpm model:login.",
            })
          }
          if (!response.body) return yield* uncertain()
          const bytes = yield* nativeBytes(
            response.body,
            65_536,
            uncertain,
            uncertain
          )
          const token = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(TokenResponse)
          )(new TextDecoder().decode(bytes)).pipe(
            Effect.mapError(
              () =>
                new CredentialRefreshError({
                  reason: "invalid",
                  message:
                    "ChatGPT credential refresh could not be verified. Reconnect the account.",
                })
            )
          )
          if (
            !token.scope.split(/\s+/).includes("chatgpt.tokens.use.direct") ||
            token.expires_in <= 0
          )
            return yield* new CredentialRefreshError({
              reason: "invalid",
              message:
                "ChatGPT grant does not permit model requests. Reconnect the account.",
            })
          const next = {
            type: "oauth" as const,
            clientId: credential.clientId,
            access: token.access_token,
            refresh: token.refresh_token,
            expires:
              (yield* Clock.currentTimeMillis) +
              token.expires_in * 1000 -
              180_000,
          }
          return yield* Schema.decodeUnknownEffect(OAuthCredential)(next).pipe(
            Effect.mapError(uncertain)
          )
        })
      ),
      (observed) =>
        observed.pipe(
          Effect.timeoutOrElse({
            duration: "30 seconds",
            orElse: () =>
              new CredentialRefreshError({
                reason: "timeout",
                message:
                  "ChatGPT credential refresh timed out without confirmation. Reconnect the account.",
              }),
          })
        )
    )
)
