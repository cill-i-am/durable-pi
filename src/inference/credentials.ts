import { createEffectActor, send, waitFor } from "@xstate/effect"
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Scope,
  Semaphore,
} from "effect"

import { orDieAll, preserveFatal } from "../shared/effect"
import {
  CredentialCorrupt,
  CredentialUnavailable,
  credentialNeedsRefresh,
  sameCredential,
  type AccountCredentialError,
  type CredentialError,
  type CredentialLedger,
  type CredentialRefresh,
  type ModelCredential,
  type OAuthCredential,
} from "./credential-domain"
import {
  credentialHostMachine,
  type CredentialWork,
} from "./credential-host.machine"
import {
  advanceCredentialRotation,
  readyRotation,
} from "./credential-rotation.machine"
export * from "./credential-domain"

const unconfirmed = () =>
  new CredentialUnavailable({
    message:
      "ChatGPT credential refresh could not be confirmed. Reconnect the account before trying again.",
  })
const stopped = () =>
  new CredentialUnavailable({
    message: "The model credential host has stopped.",
  })
const credentialFailure = <A>(work: Effect.Effect<A, AccountCredentialError>) =>
  work.pipe(
    preserveFatal,
    Effect.catchTag("ChatGPTSignInError", (error) =>
      Effect.fail(new CredentialUnavailable({ message: error.message }))
    )
  )
export class ModelCredentials extends Context.Service<
  ModelCredentials,
  {
    connection: () => Effect.Effect<string | undefined, CredentialError>
    registration: () => Effect.Effect<
      ModelCredential | undefined,
      CredentialError
    >
    shutdown: () => Effect.Effect<void>
    install: (
      value: OAuthCredential,
      admission?: Effect.Effect<void, CredentialError>
    ) => Effect.Effect<void, CredentialError>
    connect: (
      exchange: Effect.Effect<OAuthCredential, AccountCredentialError>,
      admission: Effect.Effect<void, CredentialError>,
      expectedConnectionId: string,
      settled?: (
        outcome: Exit.Exit<OAuthCredential, AccountCredentialError>
      ) => Effect.Effect<void, AccountCredentialError>
    ) => Effect.Effect<OAuthCredential, AccountCredentialError>
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
    // Initialization cannot lose the detached owner between acquisition and cleanup registration.
    const owner = yield* Effect.acquireRelease(Scope.make(), (scope, exit) =>
      Scope.close(scope, exit)
    )
    const host = yield* createEffectActor(credentialHostMachine).pipe(
      Scope.provide(owner)
    )
    const admission = yield* Semaphore.make(1)
    const wait = (work: CredentialWork) =>
      Deferred.await(work.result).pipe(
        Effect.onInterrupt(() =>
          Deferred.await(work.result).pipe(
            Effect.exit,
            Effect.flatMap((exit) =>
              Exit.isFailure(exit) && Cause.hasDies(exit.cause)
                ? Effect.failCause(exit.cause).pipe(orDieAll)
                : Effect.void
            )
          )
        )
      )
    const shutdown = () =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const pending = host.getSnapshot().context.work
          const failure = host.getSnapshot().context.failure
          yield* send(host, { type: "CLOSE" })
          yield* waitFor(host, (state) => state.matches("closing")).pipe(
            Effect.orDie
          )
          yield* admission.withPermit(Effect.void)
          yield* Scope.close(owner, Exit.void)
          const settled = pending
            ? yield* Effect.exit(Deferred.await(pending.result))
            : undefined
          const cause =
            settled && Exit.isFailure(settled) && Cause.hasDies(settled.cause)
              ? settled.cause
              : failure
          if (cause) return yield* Effect.failCause(cause).pipe(orDieAll)
        })
      )
    yield* Effect.addFinalizer(shutdown)
    const ensureOpen = (allowFailure = false) =>
      Effect.suspend(() => {
        const state = host.getSnapshot()
        if (state.matches("closing")) return Effect.fail(stopped())
        if (!allowFailure && state.context.failure)
          return Effect.failCause(state.context.failure).pipe(credentialFailure)
        return Effect.void
      })
    const readCurrent = (allowFailure = false) =>
      ledger.atomic(() =>
        Effect.gen(function* () {
          yield* ensureOpen(allowFailure)
          const row = yield* ledger.read("openai")
          if (!row || !row.seedCurrent) {
            const seed = yield* ledger.seed()
            if (seed) {
              const value =
                seed.type === "oauth"
                  ? { ...seed, connectionId: crypto.randomUUID() }
                  : seed
              const rotation = readyRotation(
                value.type === "oauth" ? value.connectionId! : null
              )
              yield* ledger.put("openai", value, rotation)
              return {
                value,
                seedCurrent: true as const,
                rotation,
                refreshing: false,
              }
            }
            if (row) throw new CredentialCorrupt()
            return undefined
          }
          if (row.value.type === "oauth" && !row.value.connectionId) {
            const value = { ...row.value, connectionId: crypto.randomUUID() }
            const rotation = {
              ...row.rotation,
              connectionId: value.connectionId,
            }
            yield* ledger.put("openai", value, rotation)
            return { ...row, value, rotation }
          }
          return row
        })
      )
    const rotate = Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const claim = yield* ledger.atomic(() =>
          Effect.gen(function* () {
            yield* ensureOpen()
            const row = yield* readCurrent()
            if (!row) return undefined
            if (row.rotation.phase !== "ready") return yield* unconfirmed()
            const now = yield* Clock.currentTimeMillis
            if (
              row.value.type !== "oauth" ||
              !credentialNeedsRefresh(row.value, now)
            )
              return { current: row.value }
            const attemptId = host.getSnapshot().context.work!.id,
              connectionId = row.value.connectionId!
            const rotation = advanceCredentialRotation(row.rotation, {
              type: "CLAIM",
              attemptId,
              connectionId,
            })
            if (rotation.phase !== "refreshing") return yield* unconfirmed()
            yield* ledger.put("openai", row.value, rotation)
            return { current: row.value, attemptId, connectionId }
          })
        )
        if (!claim || !("attemptId" in claim)) return claim?.current
        const expected = claim.current as OAuthCredential
        // Recheck current durable ownership at dispatch, including competing account hosts.
        yield* ledger.atomic(() =>
          Effect.gen(function* () {
            yield* ensureOpen()
            const latest = yield* ledger.read("openai")
            if (
              !latest?.seedCurrent ||
              latest.rotation.phase !== "refreshing" ||
              latest.rotation.attemptId !== claim.attemptId ||
              latest.rotation.connectionId !== claim.connectionId ||
              !sameCredential(latest.value, expected)
            )
              return yield* unconfirmed()
          })
        )
        // No interruptible mailbox hop separates provider success and the fenced commit.
        const exchanged = yield* Effect.exit(
          restore(Effect.suspend(() => refresh(expected))).pipe(
            preserveFatal,
            Effect.catchTag("CredentialRefreshError", (error) =>
              Effect.fail(new CredentialUnavailable({ message: error.message }))
            )
          )
        )
        if (Exit.isFailure(exchanged)) {
          const retained = yield* Effect.exit(
            ledger.atomic(() =>
              Effect.gen(function* () {
                const latest = yield* ledger.read("openai")
                if (
                  !latest?.seedCurrent ||
                  !sameCredential(latest.value, expected)
                )
                  return
                const rotation = advanceCredentialRotation(latest.rotation, {
                  type: "UNCERTAIN",
                  attemptId: claim.attemptId!,
                  connectionId: claim.connectionId!,
                })
                if (
                  rotation.phase === "unconfirmed" &&
                  latest.rotation.phase === "refreshing"
                )
                  yield* ledger.put("openai", latest.value, rotation)
              })
            )
          )
          return yield* Effect.failCause(
            Exit.isFailure(retained)
              ? Cause.combine(exchanged.cause, retained.cause)
              : exchanged.cause
          )
        }
        const next = exchanged.value
        return yield* ledger.atomic(() =>
          Effect.gen(function* () {
            const latest = yield* ledger.read("openai")
            if (!latest?.seedCurrent || !sameCredential(latest.value, expected))
              return yield* unconfirmed()
            const rotation = advanceCredentialRotation(latest.rotation, {
              type: "COMPLETE",
              attemptId: claim.attemptId!,
              connectionId: claim.connectionId!,
            })
            if (
              rotation.phase !== "ready" ||
              latest.rotation.phase !== "refreshing"
            )
              return yield* unconfirmed()
            const value = { ...next, connectionId: claim.connectionId }
            yield* ledger.put("openai", value, rotation)
            return value
          })
        )
      })
    )
    // The actor owns the accepted operation. Admission holds no lock while waiting for network.
    const accept = (kind: CredentialWork["kind"], run: CredentialWork["run"]) =>
      admission.withPermit(
        Effect.uninterruptible(
          Effect.gen(function* () {
            yield* ensureOpen(kind !== "rotate")
            const state = host.getSnapshot()
            if (state.context.work)
              return { work: state.context.work, accepted: false }
            const result = yield* Deferred.make<
              ModelCredential | undefined,
              AccountCredentialError
            >()
            const context = yield* Effect.context<never>()
            const work: CredentialWork = {
              id: crypto.randomUUID(),
              kind,
              result,
              run: Effect.provideContext(run, context),
            }
            yield* send(host, { type: "ACCEPT", work })
            yield* waitFor(
              host,
              (snapshot) =>
                snapshot.context.lastId === work.id ||
                snapshot.matches("closing")
            ).pipe(Effect.orDie)
            if (host.getSnapshot().context.lastId !== work.id)
              return yield* stopped()
            retain(Deferred.await(work.result).pipe(Effect.exit, Effect.asVoid))
            return { work, accepted: true }
          })
        )
      )
    const join = (work: CredentialWork) =>
      wait(work).pipe(
        Effect.onExit(() =>
          waitFor(
            host,
            (state) => state.context.work !== work || state.matches("closing")
          ).pipe(Effect.orDie)
        )
      )
    const installValue = (
      value: OAuthCredential,
      authorize: Effect.Effect<void, CredentialError>,
      expectedConnectionId?: string
    ) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* ensureOpen(true)
          yield* restore(authorize)
          return yield* ledger.atomic(() =>
            Effect.gen(function* () {
              yield* ensureOpen(true)
              const current = yield* ledger.read("openai")
              if (expectedConnectionId !== undefined) {
                if (
                  !current?.seedCurrent ||
                  current.value.type !== "oauth" ||
                  current.value.connectionId !== expectedConnectionId
                )
                  return yield* new CredentialUnavailable({
                    message:
                      "The model connection changed. Start sign-in again.",
                  })
              }
              const installed = { ...value, connectionId: crypto.randomUUID() }
              yield* ledger.install("openai", installed)
              return installed
            })
          )
        })
      )
    const change = (
      kind: "install" | "connect",
      exchange: Effect.Effect<OAuthCredential, AccountCredentialError>,
      authorize: Effect.Effect<void, CredentialError>,
      expectedConnectionId?: string,
      settled: (
        outcome: Exit.Exit<OAuthCredential, AccountCredentialError>
      ) => Effect.Effect<void, AccountCredentialError> = () => Effect.void
    ): Effect.Effect<OAuthCredential, AccountCredentialError> =>
      Effect.gen(function* () {
        const receipt = yield* accept(
          kind,
          Effect.uninterruptibleMask((restore) =>
            restore(exchange).pipe(
              Effect.flatMap((value) =>
                installValue(value, authorize, expectedConnectionId)
              ),
              Effect.onExit((exit) => settled(exit).pipe(orDieAll))
            )
          )
        )
        if (receipt.accepted)
          return (yield* join(receipt.work)) as OAuthCredential
        yield* join(receipt.work).pipe(Effect.exit)
        return yield* change(
          kind,
          exchange,
          authorize,
          expectedConnectionId,
          settled
        )
      })
    const ownsRotation = (rotation: { attemptId: string | null }) => {
      const work = host.getSnapshot().context.work
      return work?.kind === "rotate" && work.id === rotation.attemptId
    }
    const service: typeof ModelCredentials.Service = {
      shutdown,
      install: (value, authorize = Effect.void) =>
        change("install", Effect.succeed(value), authorize).pipe(
          Effect.asVoid,
          credentialFailure
        ),
      connect: (exchange, authorize, expectedConnectionId, settled) =>
        change("connect", exchange, authorize, expectedConnectionId, settled),
      registration: () =>
        readCurrent(true).pipe(Effect.map((row) => row?.value)),
      connection: () =>
        Effect.gen(function* () {
          yield* ensureOpen()
          const row = yield* readCurrent()
          if (!row || row.value.type !== "oauth") return undefined
          const active = host.getSnapshot().context.work
          if (row.rotation.phase !== "ready" && !ownsRotation(row.rotation))
            return yield* unconfirmed()
          const now = yield* Clock.currentTimeMillis
          if (
            row.rotation.phase === "ready" &&
            credentialNeedsRefresh(row.value, now) &&
            !active
          )
            yield* accept("rotate", rotate)
          return row.value.connectionId
        }),
      list: () =>
        Effect.gen(function* () {
          const row = yield* readCurrent()
          return row &&
            (row.rotation.phase === "ready" || ownsRotation(row.rotation))
            ? [{ providerId: "openai", type: row.value.type }]
            : []
        }),
      resolve: (
        provider,
        refreshAhead = false
      ): Effect.Effect<ModelCredential | undefined, CredentialError> =>
        Effect.gen(function* () {
          yield* Effect.yieldNow
          yield* ensureOpen()
          if (provider !== "openai") return undefined
          if (!refreshAhead) {
            const row = yield* readCurrent()
            if (!row) return undefined
            if (row.rotation.phase !== "ready" && !ownsRotation(row.rotation))
              return yield* unconfirmed()
            const now = yield* Clock.currentTimeMillis
            if (row.value.type !== "oauth" || row.value.expires > now) {
              if (row.value.type === "oauth") {
                const identity = yield* service.connection()
                if (identity !== row.value.connectionId)
                  return yield* service.resolve(provider)
              }
              return row.value
            }
          }
          const receipt = yield* accept("rotate", rotate)
          if (receipt.work.kind === "rotate")
            return yield* join(receipt.work).pipe(credentialFailure)
          yield* join(receipt.work).pipe(Effect.exit)
          return yield* service.resolve(provider, refreshAhead)
        }),
    }
    return service
  }).pipe(Effect.uninterruptible)
export const credentialApplication = (
  ledger: CredentialLedger,
  refresh: CredentialRefresh,
  retain: (work: Effect.Effect<void>) => void = () => {}
) =>
  Layer.effect(ModelCredentials, makeModelCredentials(ledger, refresh, retain))
