import { Clock, Effect, Exit, Schema, Semaphore } from "effect"
import type { JWTVerifyGetKey } from "jose"
import { errors as joseErrors } from "jose"

import { observeCleanup } from "../../shared/effect"
import { jsonRequest } from "../../shared/http"
import { nativeOperation, nativeResponse } from "../../shared/interop"
import { nativeBytes } from "../../shared/stream"
import {
  ChatGPTSignInError,
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

export { ChatGPTSignInError } from "../credential-domain"
import { advanceSignIn, SignInState } from "../sign-in.machine"
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
  connectionId?: string
  expiresAt: number
}
interface StoredSignIn extends SignInState {
  pending?: Pending
}
const PendingValue = Schema.Struct({
  id: Schema.String,
  owner: Schema.String,
  membershipId: Schema.String,
  email: Schema.String,
  subject: Schema.optional(Schema.String),
  connectionId: Schema.optional(Schema.String),
  expiresAt: Schema.Number,
  clientId: Schema.String,
  hostId: Schema.String,
  redirectUri: Schema.String,
  state: Schema.String,
  nonce: Schema.String,
  verifier: Schema.String,
})
const serials = new WeakMap<object, ReturnType<typeof Semaphore.makeUnsafe>>()
const sharedSerial = (storage: object) => {
  const existing = serials.get(storage)
  if (existing) return existing
  const serial = Semaphore.makeUnsafe(1)
  serials.set(storage, serial)
  return serial
}
class SignInCorrupt extends Error {
  readonly _tag = "SignInCorrupt"
  constructor() {
    super(
      "The stored sign-in lifecycle is invalid. Restore the account data before reconnecting."
    )
  }
}
const decodePrivate = <A>(
  schema: Schema.ConstraintDecoder<A>,
  value: unknown
): A => {
  try {
    return Schema.decodeUnknownSync(schema)(value)
  } catch {
    throw new SignInCorrupt()
  }
}
async function readSignIn(
  storage: DurableObjectTransaction
): Promise<StoredSignIn | undefined> {
  const saved = await storage.get<Record<string, unknown>>(pendingKey)
  if (!saved) return undefined
  if (
    saved.schemaVersion !== undefined &&
    (saved.schemaVersion !== 1 || saved.workflowVersion !== 1)
  )
    throw new ChatGPTSignInError({
      message:
        "This sign-in uses a newer lifecycle. Update the application before starting again.",
    })
  if (saved.schemaVersion === undefined) {
    const pending = decodePrivate(PendingValue, saved)
    const value: StoredSignIn = {
      schemaVersion: 1,
      workflowVersion: 1,
      phase: "waiting",
      id: pending.id,
      owner: pending.owner,
      membershipId: pending.membershipId,
      expiresAt: pending.expiresAt,
      pending,
    }
    await storage.put(pendingKey, value)
    return value
  }
  const state = decodePrivate(SignInState, saved)
  const pending =
    state.phase === "waiting"
      ? decodePrivate(PendingValue, saved.pending)
      : undefined
  if (
    pending &&
    (pending.id !== state.id ||
      pending.owner !== state.owner ||
      pending.membershipId !== state.membershipId ||
      pending.expiresAt !== state.expiresAt)
  )
    throw new SignInCorrupt()
  return { ...state, ...(pending ? { pending } : {}) }
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
  private readonly serial: ReturnType<typeof Semaphore.makeUnsafe>
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
  ) {
    this.serial = sharedSerial(storage)
  }
  private stored<T>(body: (storage: DurableObjectTransaction) => Promise<T>) {
    return Effect.tryPromise({
      try: () => this.storage.transaction(body),
      catch: (cause) =>
        cause instanceof ChatGPTSignInError || cause instanceof SignInCorrupt
          ? cause
          : unavailable(),
    }).pipe(Effect.catchTag("SignInCorrupt", Effect.die))
  }
  status() {
    return this.serial.withPermit(
      Effect.gen({ self: this }, function* () {
        const principal = yield* this.admit()
        const now = yield* Clock.currentTimeMillis
        return yield* this.stored(async (storage) => {
          const saved = await readSignIn(storage)
          if (!saved || saved.phase !== "waiting") return { pending: null }
          const pending = saved.pending!
          if (
            pending.expiresAt <= now ||
            pending.owner !== principal.owner ||
            pending.membershipId !== principal.membershipId
          ) {
            await storage.put(
              pendingKey,
              advanceSignIn(saved, { type: "EXPIRE", ...saved })
            )
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
        const current = yield* this.credentials.registration()
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
          await readSignIn(storage)
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
            connectionId: current.connectionId,
            expiresAt: now + 600_000,
          }
          await storage.put(pendingKey, {
            schemaVersion: 1,
            workflowVersion: 1,
            phase: "waiting",
            id: pending.id,
            owner: pending.owner,
            membershipId: pending.membershipId,
            expiresAt: pending.expiresAt,
            pending,
          } satisfies StoredSignIn)
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
            const saved = await readSignIn(storage)
            if (saved?.phase === "waiting")
              await storage.put(
                pendingKey,
                advanceSignIn(saved, { type: "CANCEL", ...saved })
              )
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
        const current = yield* this.credentials.registration()
        if (current?.type !== "oauth" || !current.connectionId)
          return yield* expired()
        const claimed = yield* this.stored(async (storage) => {
          const saved = await readSignIn(storage)
          const pending = saved?.phase === "waiting" ? saved.pending : undefined
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
          if (
            pending.connectionId &&
            pending.connectionId !== current.connectionId
          )
            throw expired()
          return { pending, code }
        })
        const { pending, code } = claimed
        const transport = this.transport
        const authorize = Effect.suspend(() => this.admit()).pipe(
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
        const exchange = observeCleanup(
          Effect.scoped(
            Effect.gen({ self: this }, function* () {
              yield* authorize
              const clock = yield* Clock.Clock
              if (clock.currentTimeMillisUnsafe() >= pending.expiresAt)
                return yield* expired()
              // Durable code consumption happens only after the account actor owns
              // this exchange. A browser leaving while another rotation runs cannot
              // strand a consumed code in a request-owned queue.
              yield* this.stored(async (storage) => {
                const latest = await readSignIn(storage)
                if (latest?.id !== id || latest.phase !== "waiting")
                  throw expired()
                const next = advanceSignIn(latest, {
                  type: "CLAIM",
                  id,
                  ...principal,
                  // KV acquisition and reads may wait. Consult the injected clock
                  // inside the acquired transaction, never its earlier timestamp.
                  now: clock.currentTimeMillisUnsafe(),
                })
                if (next.phase !== "exchanging") throw expired()
                await storage.put(pendingKey, next)
              })
              yield* this.ledger
                .atomic(() => this.ledger.read("openai"))
                .pipe(
                  Effect.flatMap((latest) =>
                    latest?.seedCurrent &&
                    latest.value.type === "oauth" &&
                    latest.value.connectionId === current.connectionId
                      ? Effect.void
                      : Effect.fail(
                          new CredentialUnavailable({
                            message:
                              "The model connection changed. Start sign-in again.",
                          })
                        )
                  )
                )
              const response = yield* nativeResponse(
                (signal) =>
                  transport(
                    "https://auth.openai.com/api/accounts/oauth/token",
                    {
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
                    }
                  ),
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
              return yield* nativeOperation(
                () =>
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
                (cause) =>
                  cause instanceof ReturningCredentialError
                    ? cause.reason
                    : cause instanceof joseErrors.JOSEError
                      ? cause.code
                      : "invalid_token_response"
              ).pipe(
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
          ),
          (observed) =>
            observed.pipe(
              Effect.timeoutOrElse({
                duration: "30 seconds",
                orElse: unavailable,
              })
            )
        )
        const credential = yield* this.credentials.connect(
          exchange.pipe(
            Effect.flatMap((value) =>
              Schema.decodeUnknownEffect(OAuthCredential)(value).pipe(
                Effect.mapError(unavailable)
              )
            )
          ),
          authorize,
          current.connectionId,
          (outcome) =>
            this.stored(async (storage) => {
              const saved = await readSignIn(storage)
              if (saved?.id === id && saved.phase === "exchanging")
                await storage.put(
                  pendingKey,
                  advanceSignIn(saved, {
                    type: Exit.isSuccess(outcome) ? "CONNECTED" : "UNCERTAIN",
                    id,
                    ...principal,
                  })
                )
            })
        )
        return {
          status: "connected" as const,
          email: credential.identity!.email,
        }
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
