import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"
import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"

import { SqliteCredentials } from "../src/inference/adapters/credential-sqlite"
import { toNativeCredential } from "../src/inference/adapters/credentials-pi"
import { openaiCatalogSource } from "../src/inference/adapters/openai-catalog"
import { makeModelCatalog } from "../src/inference/catalog"
import {
  CredentialRefreshError,
  makeModelCredentials,
  OAuthCredential,
} from "../src/inference/credentials"
import { ModelUnavailable } from "../src/inference/policy"
import { database } from "./database"
import { account, credential } from "./inference-fixture"

it.effect(
  "refresh-ahead leaves valid inference and catalog reads unblocked, and rotation preserves persisted identity",
  () =>
    Effect.gen(function* () {
      const db = database()
      const ledger = new SqliteCredentials(
        db,
        Redacted.make(JSON.stringify({ ...credential, expires: 400_000 }))
      )
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let refreshes = 0
      let discoveries = 0
      const service = yield* makeModelCredentials(ledger, (current) =>
        Effect.gen(function* () {
          refreshes++
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
          return {
            ...current,
            access: Redacted.make("rotated"),
            expires: 900_000,
          }
        })
      )
      const source = openaiCatalogSource(
        () =>
          service.resolve("openai").pipe(
            Effect.map((value) =>
              value ? toNativeCredential(value) : undefined
            ),
            Effect.mapError(
              () => new ModelUnavailable({ message: "Credential failed" })
            )
          ),
        () => openaiProvider().getModels(),
        async () => {
          discoveries++
          return Response.json(account)
        },
        () =>
          service
            .connection()
            .pipe(
              Effect.mapError(
                () => new ModelUnavailable({ message: "Connection failed" })
              )
            )
      )
      const catalog = yield* makeModelCatalog(source)
      yield* TestClock.setTime(0)
      const before = yield* source.current()
      yield* catalog.read()
      yield* TestClock.setTime(100_000)
      const during = yield* source.current()
      yield* Deferred.await(entered)
      expect(during.identity).toBe(before.identity)
      expect((yield* catalog.read()).error).toBeNull()
      expect(discoveries).toBe(1)
      expect(yield* service.resolve("openai")).toMatchObject({
        expires: 400_000,
      })
      expect(yield* service.list()).toHaveLength(1)
      yield* TestClock.setTime(400_000)
      let completed = false
      const expired = yield* Effect.forkChild(
        service.resolve("openai").pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              completed = true
            })
          )
        )
      )
      yield* Effect.yieldNow
      expect(completed).toBe(false)
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(expired)).toMatchObject({ expires: 900_000 })
      expect((yield* source.current()).identity).toBe(before.identity)
      const restored = yield* makeModelCredentials(ledger, () =>
        Effect.die("must not refresh")
      )
      expect(yield* restored.connection()).toBe(yield* service.connection())
      expect(refreshes).toBe(1)
      const oldId = yield* service.connection()
      yield* service.install(
        Schema.decodeUnknownSync(OAuthCredential)({
          ...credential,
          expires: 900_000,
        })
      )
      expect(yield* service.connection()).not.toBe(oldId)
    })
)

it.effect(
  "a failed proactive rotation blocks metadata and token reuse, including after restart",
  () =>
    Effect.gen(function* () {
      const ledger = new SqliteCredentials(
        database(),
        Redacted.make(JSON.stringify({ ...credential, expires: 100_000 }))
      )
      const done = yield* Deferred.make<void>()
      const service = yield* makeModelCredentials(ledger, () =>
        Effect.fail(
          new CredentialRefreshError({ reason: "rejected", message: "Denied" })
        ).pipe(Effect.ensuring(Deferred.succeed(done, undefined)))
      )
      yield* TestClock.setTime(0)
      expect(yield* service.connection()).toEqual(expect.any(String))
      yield* Deferred.await(done)
      yield* Effect.yieldNow
      expect((yield* service.connection().pipe(Effect.result))._tag).toBe(
        "Failure"
      )
      expect((yield* service.resolve("openai").pipe(Effect.result))._tag).toBe(
        "Failure"
      )
      const restored = yield* makeModelCredentials(ledger, () =>
        Effect.die("must not replay failed rotation")
      )
      expect((yield* restored.connection().pipe(Effect.result))._tag).toBe(
        "Failure"
      )
    })
)
