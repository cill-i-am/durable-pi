import { Clock, Effect, Schema, Semaphore } from "effect"
import type { JWTVerifyGetKey } from "jose"
import { errors as joseErrors } from "jose"

import { jsonRequest } from "../../shared/http"
import { nativeResponse } from "../../shared/interop"
import { nativeBytes } from "../../shared/stream"
import {
  CredentialUnavailable,
  OAuthCredential,
  type CredentialLedger,
  type CredentialError,
  type ModelCredentials,
} from "../credentials"
import {
  returningCredential,
  returningSignInCallback,
  returningSignInUrl,
  ReturningCredentialError,
  type ReturningSignIn,
} from "./sign-in-protocol"

export class ChatGPTSignInError extends Schema.TaggedError<ChatGPTSignInError>()(
  "ChatGPTSignInError",
  { message: Schema.String }
) {}
const unavailable = () =>
  new ChatGPTSignInError({
    message:
      "Could not finish ChatGPT sign-in. Start again; your existing connection has been kept.",
  })
const expired = () =>
  new ChatGPTSignInError({
    message: "This sign-in has expired or was already used. Start again.",
  })
const invalid = () =>
  new ChatGPTSignInError({
    message:
      "Paste the full return address from the ChatGPT sign-in you just opened.",
  })
const pendingKey = "chatgpt-pending-sign-in-v1"
const hostKey = "chatgpt-host-v1"
interface Principal {
  owner: string
  membershipId: string
}
interface Pending extends ReturningSignIn, Principal {
  id: string
  email: string
  subject?: string
  expiresAt: number
}
const random = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
}
const publicPending = (pending: Pending) => ({
  id: pending.id,
  email: pending.email,
  expiresAt: pending.expiresAt,
  authorizationUrl: returningSignInUrl(pending),
})
export type ChatGPTSignInPending = ReturnType<typeof publicPending>

/** One admin-owned attempt. KV transactions only claim local state; network I/O
 * runs after consumption, and the grant is installed by the refresh authority. */
export class ChatGPTSignIn {
  private readonly serial = Semaphore.makeUnsafe(1)
  constructor(
    private readonly storage: Pick<DurableObjectStorage, "transaction">,
    private readonly ledger: CredentialLedger,
    private readonly credentials: typeof ModelCredentials.Service,
    private readonly admit: () => Effect.Effect<
      Principal,
      CredentialUnavailable
    >,
    private readonly transport: typeof fetch = fetch,
    private readonly keys?: JWTVerifyGetKey
  ) {}
  private stored<T>(body: (storage: DurableObjectTransaction) => Promise<T>) {
    return Effect.tryPromise({
      try: () => this.storage.transaction(body),
      catch: (cause) =>
        cause instanceof ChatGPTSignInError ? cause : unavailable(),
    })
  }
  status() {
    return this.serial.withPermit(
      Effect.gen({ self: this }, function* () {
        const principal = yield* this.admit()
        const now = yield* Clock.currentTimeMillis
        return yield* this.stored(async (storage) => {
          const pending = await storage.get<Pending>(pendingKey)
          if (!pending) return { pending: null }
          if (
            pending.expiresAt <= now ||
            pending.owner !== principal.owner ||
            pending.membershipId !== principal.membershipId
          ) {
            await storage.delete(pendingKey)
            return { pending: null }
          }
          return { pending: publicPending(pending) }
        })
      })
    )
  }
  start(email: string) {
    return this.serial.withPermit(
      Effect.gen({ self: this }, function* () {
        const principal = yield* this.admit()
        const row = yield* this.ledger.atomic(() => this.ledger.read("openai"))
        const current = row?.seedCurrent ? row.value : yield* this.ledger.seed()
        if (
          current?.type !== "oauth" ||
          current.clientId === "dynamic_agent_client"
        )
          return yield* new ChatGPTSignInError({
            message:
              "This workspace has no saved Pi ChatGPT registration to reconnect.",
          })
        const now = yield* Clock.currentTimeMillis
        return yield* this.stored(async (storage) => {
          const hostId =
            (await storage.get<string>(hostKey)) ?? crypto.randomUUID()
          await storage.put(hostKey, hostId)
          const pending: Pending = {
            ...principal,
            clientId: current.clientId,
            hostId,
            redirectUri: `http://127.0.0.1:${49152 + (crypto.getRandomValues(new Uint16Array(1))[0]! % 16384)}/auth/callback`,
            id: crypto.randomUUID(),
            state: random(),
            nonce: random(),
            verifier: random(),
            email: email.trim().toLowerCase(),
            subject: current.identity?.subject,
            expiresAt: now + 600_000,
          }
          await storage.put(pendingKey, pending)
          return publicPending(pending)
        })
      })
    )
  }
  cancel() {
    return this.serial.withPermit(
      this.admit().pipe(
        Effect.andThen(
          this.stored(async (storage) => {
            await storage.delete(pendingKey)
            return { ok: true }
          })
        )
      )
    )
  }
  finish(id: string, address: string) {
    return this.serial.withPermit(
      Effect.gen({ self: this }, function* () {
        const principal = yield* this.admit()
        const now = yield* Clock.currentTimeMillis
        const claimed = yield* this.stored(async (storage) => {
          const pending = await storage.get<Pending>(pendingKey)
          if (
            !pending ||
            pending.id !== id ||
            pending.expiresAt <= now ||
            pending.owner !== principal.owner ||
            pending.membershipId !== principal.membershipId
          )
            throw expired()
          let code: string
          try {
            code = returningSignInCallback(address.trim(), pending)
          } catch {
            throw invalid()
          }
          // Consume before dispatch. A code exchange with an uncertain outcome is
          // never repeated, including after the actor restarts.
          await storage.delete(pendingKey)
          return { pending, code }
        })
        const { pending, code } = claimed
        const transport = this.transport
        const value = yield* Effect.scoped(
          Effect.gen({ self: this }, function* () {
            const response = yield* nativeResponse(
              (signal) =>
                transport("https://auth.openai.com/api/accounts/oauth/token", {
                  method: "POST",
                  redirect: "manual",
                  signal,
                  headers: {
                    "content-type": "application/x-www-form-urlencoded",
                    accept: "application/json",
                  },
                  body: new URLSearchParams({
                    grant_type: "authorization_code",
                    client_id: pending.clientId,
                    code,
                    code_verifier: pending.verifier,
                    redirect_uri: pending.redirectUri,
                    resource: "https://api.openai.com/v1",
                  }),
                }),
              unavailable
            )
            if (!response.ok || !response.body) {
              yield* Effect.logWarning("ChatGPT.signInRejected").pipe(
                Effect.annotateLogs({
                  stage: "token_exchange",
                  status: response.status,
                })
              )
              return yield* unavailable()
            }
            const bytes = yield* nativeBytes(
              response.body,
              65_536,
              unavailable,
              unavailable
            )
            return yield* Effect.tryPromise({
              try: () =>
                returningCredential(
                  JSON.parse(new TextDecoder().decode(bytes)),
                  {
                    clientId: pending.clientId,
                    nonce: pending.nonce,
                    expectedEmail: pending.email,
                    expectedSubject: pending.subject,
                  },
                  this.keys
                ),
              catch: (cause) =>
                cause instanceof ReturningCredentialError
                  ? cause.reason
                  : cause instanceof joseErrors.JOSEError
                    ? cause.code
                    : "invalid_token_response",
            }).pipe(
              Effect.tapError((reason) =>
                Effect.logWarning("ChatGPT.signInRejected").pipe(
                  Effect.annotateLogs({
                    stage: "credential_validation",
                    reason,
                  })
                )
              ),
              Effect.mapError(unavailable)
            )
          })
        ).pipe(
          Effect.timeoutOrElse({ duration: "30 seconds", orElse: unavailable })
        )
        const credential = yield* Schema.decodeUnknownEffect(OAuthCredential)(
          value
        ).pipe(Effect.mapError(unavailable))
        yield* this.credentials.install(
          credential,
          this.admit().pipe(
            Effect.flatMap((latest) =>
              latest.owner === principal.owner &&
              latest.membershipId === principal.membershipId
                ? Effect.void
                : Effect.fail(
                    new CredentialUnavailable({
                      message:
                        "Family admin access changed. Start sign-in again.",
                    })
                  )
            )
          )
        )
        return { status: "connected" as const, email: value.identity.email }
      })
    )
  }
}

const email = Schema.String.check(
  Schema.isMaxLength(254),
  Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)
)
const action = Schema.Union([
  Schema.Struct({ action: Schema.Literal("start"), email }),
  Schema.Struct({ action: Schema.Literal("cancel") }),
  Schema.Struct({
    action: Schema.Literal("finish"),
    id: Schema.String.check(Schema.isMaxLength(100)),
    address: Schema.String.check(Schema.isMaxLength(8192)),
  }),
])
export function chatGPTSignInRequest(service: ChatGPTSignIn, request: Request) {
  const work: Effect.Effect<
    Schema.Json | null,
    ChatGPTSignInError | CredentialError
  > =
    request.method === "GET"
      ? service.status()
      : request.method === "POST"
        ? jsonRequest(request, action, 16_384, invalid).pipe(
            Effect.flatMap(
              (
                input
              ): Effect.Effect<
                Schema.Json,
                ChatGPTSignInError | CredentialError
              > => {
                switch (input.action) {
                  case "start":
                    return service.start(input.email)
                  case "cancel":
                    return service.cancel()
                  case "finish":
                    return service.finish(input.id, input.address)
                }
              }
            )
          )
        : Effect.succeed(null)
  return work.pipe(
    Effect.map((value) =>
      value === null
        ? new Response(null, { status: 405 })
        : Response.json(value)
    ),
    Effect.catchTag("ChatGPTSignInError", (error) =>
      Effect.succeed(Response.json({ error: error.message }, { status: 400 }))
    ),
    Effect.catchTag("CredentialUnavailable", (error) =>
      Effect.succeed(Response.json({ error: error.message }, { status: 403 }))
    ),
    Effect.catchTag("CredentialStorageError", () =>
      Effect.succeed(
        Response.json(
          {
            error:
              "Could not save the ChatGPT connection. Start sign-in again.",
          },
          { status: 503 }
        )
      )
    )
  )
}
