import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Equal,
  Exit,
  Fiber,
  Layer,
  Schema,
  Semaphore,
} from "effect"

import { orDieAll, preserveFatal } from "../shared/effect"

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
  | { value: ModelCredential; seedCurrent: true; refreshing: boolean }
  | { seedCurrent: false; refreshing: boolean }

export interface CredentialLedger {
  atomic: <TValue, TError, TRequirements>(
    body: () => Effect.Effect<TValue, TError, TRequirements>
  ) => Effect.Effect<TValue, TError | CredentialStorageError, TRequirements>
  read: (
    provider: string
  ) => Effect.Effect<CredentialRecord | undefined, CredentialStorageError>
  seed: () => Effect.Effect<ModelCredential | undefined>
  put: (
    provider: string,
    value: ModelCredential
  ) => Effect.Effect<void, CredentialStorageError>
  install: (
    provider: string,
    value: ModelCredential
  ) => Effect.Effect<void, CredentialStorageError>
  claim: (
    provider: string,
    active: boolean
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
const unconfirmed = () =>
  new CredentialUnavailable({
    message:
      "TValue ChatGPT credential refresh could not be confirmed. Reconnect the account before trying again.",
  })
export class ModelCredentials extends Context.Service<
  ModelCredentials,
  {
    connection: () => Effect.Effect<string | undefined, CredentialError>
    shutdown: () => Effect.Effect<void>
    install: (
      value: OAuthCredential,
      admission?: Effect.Effect<void, CredentialError>
    ) => Effect.Effect<void, CredentialError>
    list: () => Effect.Effect<
      Array<{ providerId: string; type: ModelCredential["type"] }>,
      CredentialError
    >
    resolve: (
      provider: string,
      refreshAhead?: boolean
    ) => Effect.Effect<ModelCredential | undefined, CredentialError>
  }
>()("durable-pi/inference/ModelCredentials") {}

export const makeModelCredentials = (
  ledger: CredentialLedger,
  refresh: CredentialRefresh,
  retain: (work: Effect.Effect<void>) => void = () => {}
) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const active = new Map<
      string,
      Fiber.Fiber<ModelCredential, CredentialError>
    >()
    let fatal: Cause.Cause<CredentialError> | undefined
    let closed = false
    let warming = false
    const connection = yield* Semaphore.make(1)
    const shutdown = () =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          closed = true
          for (const fiber of active.values()) yield* Fiber.interrupt(fiber)
          if (fatal) return yield* Effect.failCause(fatal).pipe(orDieAll)
        })
      )
    yield* Effect.addFinalizer(shutdown)
    const wait = (fiber: Fiber.Fiber<ModelCredential, CredentialError>) =>
      Fiber.join(fiber).pipe(
        // An accepted rotation belongs to the account. TValue departing waiter joins its
        // settlement without cancelling it or losing newly rotated tokens.
        Effect.onInterrupt(() =>
          Fiber.await(fiber).pipe(
            Effect.flatMap((exit) =>
              Exit.isFailure(exit) && Cause.hasDies(exit.cause)
                ? Effect.failCause(exit.cause).pipe(orDieAll)
                : Effect.void
            )
          )
        )
      )
    const readCurrent = (provider: string) =>
      ledger.atomic(() =>
        Effect.gen(function* () {
          const row = yield* ledger.read(provider)
          if (!row || !row.seedCurrent) {
            const seed = yield* ledger.seed()
            if (seed) {
              const value =
                seed.type === "oauth"
                  ? { ...seed, connectionId: crypto.randomUUID() }
                  : seed
              yield* ledger.put(provider, value)
              yield* ledger.claim(provider, false)
              return {
                value,
                seedCurrent: true,
                refreshing: false,
              } satisfies CredentialRecord
            }
            if (row) throw new CredentialCorrupt()
          }
          if (
            row?.seedCurrent &&
            row.value.type === "oauth" &&
            !row.value.connectionId
          ) {
            const value = { ...row.value, connectionId: crypto.randomUUID() }
            yield* ledger.put(provider, value)
            return { ...row, value }
          }
          return row
        })
      )
    const service: typeof ModelCredentials.Service = {
      connection: Effect.fn("Inference.connectionIdentity")(function* () {
        yield* Effect.yieldNow
        if (closed)
          return yield* new CredentialUnavailable({
            message: "The model credential host has stopped.",
          })
        if (fatal) return yield* Effect.failCause(fatal)
        const row = yield* readCurrent("openai")
        if (!row || row.value.type !== "oauth") return undefined
        // A known owner may still be rotating. An orphaned intent is uncertain.
        if (row.refreshing && !active.has("openai") && !warming)
          return yield* unconfirmed()
        const now = yield* Clock.currentTimeMillis
        if (
          !warming &&
          !row.refreshing &&
          credentialNeedsRefresh(row.value, now)
        ) {
          warming = true
          const fiber = yield* Effect.forkIn(
            service.resolve("openai", true).pipe(
              Effect.asVoid,
              Effect.ensuring(
                Effect.sync(() => {
                  warming = false
                })
              )
            ),
            scope
          )
          // The account scope owns rotation; a browser departure cannot cancel it.
          retain(Fiber.await(fiber).pipe(Effect.asVoid))
        }
        return row.value.connectionId
      }),
      shutdown,
      install: (
        value: OAuthCredential,
        admission: Effect.Effect<void, CredentialError> = Effect.void
      ) =>
        connection.withPermit(
          Effect.gen(function* () {
            if (closed)
              return yield* new CredentialUnavailable({
                message: "The model credential host has stopped.",
              })
            const pending = active.get("openai")
            if (pending) yield* Fiber.await(pending)
            if (closed)
              return yield* new CredentialUnavailable({
                message: "The model credential host has stopped.",
              })
            yield* admission
            yield* Effect.uninterruptible(
              ledger.atomic(() =>
                Effect.gen(function* () {
                  yield* ledger.install("openai", {
                    ...value,
                    connectionId: crypto.randomUUID(),
                  })
                  yield* ledger.claim("openai", false)
                })
              )
            )
            fatal = undefined
          })
        ),
      list: Effect.fn("Inference.listCredentials")(function* () {
        if (closed)
          return yield* new CredentialUnavailable({
            message: "The model credential host has stopped.",
          })
        const row = yield* readCurrent("openai")
        return row && (!row.refreshing || active.has("openai"))
          ? [{ providerId: "openai", type: row.value.type }]
          : []
      }),
      resolve: Effect.fn("Inference.resolveCredential")(
        (provider: string, refreshAhead = false) =>
          Effect.gen(function* () {
            yield* Effect.yieldNow
            if (closed)
              return yield* new CredentialUnavailable({
                message: "The model credential host has stopped.",
              })
            if (fatal) return yield* Effect.failCause(fatal)
            if (provider !== "openai") return undefined
            if (!refreshAhead) {
              const row = yield* readCurrent(provider)
              if (!row) return undefined
              if (row.refreshing && !active.has(provider) && !warming)
                return yield* unconfirmed()
              const now = yield* Clock.currentTimeMillis
              // expires is the usable-until time (already includes the three-minute
              // safety buffer). Refresh-ahead must not block an otherwise valid token.
              if (row.value.type !== "oauth" || row.value.expires > now) {
                if (row.value.type === "oauth") {
                  const identity = yield* service.connection()
                  if (identity !== row.value.connectionId)
                    return yield* service.resolve(provider)
                }
                return row.value
              }
            }
            return yield* connection.withPermit(
              Effect.yieldNow.pipe(
                Effect.andThen(
                  Effect.uninterruptibleMask((restore) =>
                    Effect.gen(function* () {
                      if (closed)
                        return yield* new CredentialUnavailable({
                          message: "The model credential host has stopped.",
                        })
                      if (provider !== "openai") return undefined
                      if (fatal) return yield* Effect.failCause(fatal)
                      const pending = active.get(provider)
                      if (pending) return yield* restore(wait(pending))
                      const now = yield* Clock.currentTimeMillis
                      const current = yield* readCurrent(provider)
                      if (!current) return undefined
                      if (current.refreshing) return yield* unconfirmed()
                      if (
                        current.value.type !== "oauth" ||
                        !credentialNeedsRefresh(current.value, now)
                      )
                        return current.value
                      const expected = current.value
                      yield* ledger.atomic(() => ledger.claim(provider, true))
                      const begin = yield* Deferred.make<void>()
                      const work = Deferred.await(begin).pipe(
                        Effect.andThen(
                          Effect.uninterruptibleMask((restoreRefresh) =>
                            Effect.gen(function* () {
                              const next = yield* restoreRefresh(
                                refresh(expected)
                              ).pipe(
                                preserveFatal,
                                Effect.catchTag(
                                  "CredentialRefreshError",
                                  (error) =>
                                    Effect.gen(function* () {
                                      // Retain the intent on every failed rotation. A reconnect
                                      // installs a new generation and is the recovery boundary.
                                      return yield* new CredentialUnavailable({
                                        message: error.message,
                                      })
                                    })
                                )
                              )
                              return yield* ledger
                                .atomic(() =>
                                  Effect.gen(function* () {
                                    const latest = yield* ledger.read(provider)
                                    if (
                                      !latest?.seedCurrent ||
                                      !latest.refreshing ||
                                      !sameCredential(latest.value, expected)
                                    )
                                      return undefined
                                    yield* ledger.put(provider, {
                                      ...next,
                                      connectionId: expected.connectionId,
                                    })
                                    yield* ledger.claim(provider, false)
                                    return {
                                      ...next,
                                      connectionId: expected.connectionId,
                                    }
                                  })
                                )
                                .pipe(
                                  Effect.flatMap((value) =>
                                    value
                                      ? Effect.succeed(value)
                                      : Effect.fail(unconfirmed())
                                  )
                                )
                            })
                          )
                        ),
                        Effect.onExit((exit) =>
                          Effect.sync(() => {
                            if (
                              Exit.isFailure(exit) &&
                              Cause.hasDies(exit.cause)
                            )
                              fatal = exit.cause
                            active.delete(provider)
                          })
                        )
                      )
                      const fiber = yield* Effect.forkIn(
                        Effect.interruptible(work),
                        scope
                      )
                      active.set(provider, fiber)
                      yield* Deferred.succeed(begin, undefined)
                      return yield* restore(wait(fiber))
                    })
                  )
                )
              )
            )
          })
      ),
    }
    return service
  })
export const credentialApplication = (
  ledger: CredentialLedger,
  refresh: CredentialRefresh,
  retain: (work: Effect.Effect<void>) => void = () => {}
) =>
  Layer.effect(ModelCredentials, makeModelCredentials(ledger, refresh, retain))
