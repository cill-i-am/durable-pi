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
    ? a.expires === b.expires &&
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
    shutdown: () => Effect.Effect<void>
    list: () => Effect.Effect<
      Array<{ providerId: string; type: ModelCredential["type"] }>,
      CredentialError
    >
    resolve: (
      provider: string
    ) => Effect.Effect<ModelCredential | undefined, CredentialError>
  }
>()("durable-pi/inference/ModelCredentials") {}

export const makeModelCredentials = (
  ledger: CredentialLedger,
  refresh: CredentialRefresh
) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const active = new Map<
      string,
      Fiber.Fiber<ModelCredential, CredentialError>
    >()
    let fatal: Cause.Cause<CredentialError> | undefined
    let closed = false
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
              yield* ledger.put(provider, seed)
              yield* ledger.claim(provider, false)
              return {
                value: seed,
                seedCurrent: true,
                refreshing: false,
              } satisfies CredentialRecord
            }
            if (row) throw new CredentialCorrupt()
          }
          return row
        })
      )
    return {
      shutdown,
      list: Effect.fn("Inference.listCredentials")(function* () {
        if (closed)
          return yield* new CredentialUnavailable({
            message: "The model credential host has stopped.",
          })
        const row = yield* readCurrent("openai")
        return row && !row.refreshing
          ? [{ providerId: "openai", type: row.value.type }]
          : []
      }),
      resolve: Effect.fn("Inference.resolveCredential")((provider: string) =>
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
                          Effect.catchTag("CredentialRefreshError", (error) =>
                            Effect.gen(function* () {
                              // TValue decoded OAuth error confirms denial; transport/invalid-success
                              // outcomes may have rotated the secret and retain the intent.
                              if (error.reason === "rejected")
                                yield* ledger.atomic(() =>
                                  Effect.gen(function* () {
                                    const latest = yield* ledger.read(provider)
                                    if (
                                      latest?.seedCurrent &&
                                      sameCredential(latest.value, expected)
                                    )
                                      yield* ledger.claim(provider, false)
                                  })
                                )
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
                              yield* ledger.put(provider, next)
                              yield* ledger.claim(provider, false)
                              return next
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
                      if (Exit.isFailure(exit) && Cause.hasDies(exit.cause))
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
      ),
    }
  })
export const credentialApplication = (
  ledger: CredentialLedger,
  refresh: CredentialRefresh
) => Layer.effect(ModelCredentials, makeModelCredentials(ledger, refresh))
