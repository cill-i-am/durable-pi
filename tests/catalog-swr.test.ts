import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"

import {
  makeModelCatalog,
  type CatalogSnapshot,
  type CatalogStorage,
} from "../src/inference/catalog"
import { ModelUnavailable } from "../src/inference/policy"
import { catalog } from "./inference-fixture"

it.effect(
  "stale reads and concurrent sends return while one refresh is blocked, including after restart",
  () =>
    Effect.gen(function* () {
      let saved: CatalogSnapshot | undefined
      let calls = 0
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const storage: CatalogStorage = {
        read: () => Effect.sync(() => saved),
        write: (value) =>
          Effect.sync(() => {
            saved = value
          }),
      }
      const source = {
        current: () =>
          Effect.succeed({
            identity: "connection-a",
            load: () =>
              Effect.gen(function* () {
                calls++
                if (calls > 1) {
                  yield* Deferred.succeed(entered, undefined)
                  yield* Deferred.await(release)
                }
                return catalog
              }),
          }),
      }
      const first = yield* makeModelCatalog(source, { storage })
      yield* first.read()
      const restarted = yield* makeModelCatalog(source, { storage })
      expect(yield* restarted.read()).toEqual(catalog)
      expect(calls).toBe(1)
      yield* TestClock.adjust("5 minutes")
      expect(yield* restarted.read()).toEqual(catalog)
      yield* Deferred.await(entered)
      for (let i = 0; i < 10; i++)
        expect(yield* restarted.read()).toEqual(catalog)
      expect(calls).toBe(2)
      yield* Deferred.succeed(release, undefined)
    })
)

it.effect(
  "transient refresh failure keeps success with backoff but never beyond one hour",
  () =>
    Effect.gen(function* () {
      let calls = 0
      const reader = yield* makeModelCatalog({
        current: () =>
          Effect.succeed({
            identity: "a",
            load: () => {
              calls++
              return calls === 1
                ? Effect.succeed(catalog)
                : Effect.fail(
                    new ModelUnavailable({
                      message: "unavailable",
                      reason: "transient",
                    })
                  )
            },
          }),
      })
      yield* reader.read()
      yield* TestClock.adjust("5 minutes")
      expect(yield* reader.read()).toEqual(catalog)
      yield* Effect.yieldNow
      expect(yield* reader.read()).toEqual(catalog)
      expect(calls).toBe(2)
      yield* TestClock.adjust("55 minutes")
      expect((yield* reader.read()).error).toBe("unavailable")
      expect(calls).toBe(3)
    })
)

it.effect(
  "confirmed denial is persisted and blocks stale reuse after restart",
  () =>
    Effect.gen(function* () {
      let saved: CatalogSnapshot | undefined
      let denied = false
      const storage: CatalogStorage = {
        read: () => Effect.sync(() => saved),
        write: (value) =>
          Effect.sync(() => {
            saved = value
          }),
      }
      const source = {
        current: () =>
          Effect.succeed({
            identity: "a",
            load: () =>
              denied
                ? Effect.fail(
                    new ModelUnavailable({
                      message: "Reconnect",
                      reason: "denied",
                    })
                  )
                : Effect.succeed(catalog),
          }),
      }
      const reader = yield* makeModelCatalog(source, { storage })
      yield* reader.read()
      denied = true
      yield* TestClock.adjust("5 minutes")
      yield* reader.read()
      yield* Effect.yieldNow
      const restarted = yield* makeModelCatalog(source, { storage })
      expect((yield* restarted.read()).error).toBe("Reconnect")
    })
)

it.effect(
  "reconnect during background refresh cannot publish old account capabilities",
  () =>
    Effect.gen(function* () {
      let identity = "a"
      let calls = 0
      let saved: CatalogSnapshot | undefined
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const reader = yield* makeModelCatalog(
        {
          current: () =>
            Effect.succeed({
              identity,
              load: () =>
                Effect.gen(function* () {
                  calls++
                  if (calls === 2) {
                    yield* Deferred.succeed(entered, undefined)
                    yield* Deferred.await(release)
                  }
                  return catalog
                }),
            }),
        },
        {
          storage: {
            read: () => Effect.sync(() => saved),
            write: (value) =>
              Effect.sync(() => {
                saved = value
              }),
          },
        }
      )
      yield* reader.read()
      yield* TestClock.adjust("5 minutes")
      yield* reader.read()
      yield* Deferred.await(entered)
      identity = "b"
      yield* reader.read()
      expect(saved?.identity).toBe("b")
      yield* Deferred.succeed(release, undefined)
      yield* Effect.yieldNow
      expect(saved?.identity).toBe("b")
    })
)

it.effect(
  "a hard-expired snapshot waits for discovery and caller interruption does not cancel other readers",
  () =>
    Effect.gen(function* () {
      let calls = 0
      const release = yield* Deferred.make<void>()
      const reader = yield* makeModelCatalog({
        current: () =>
          Effect.succeed({
            identity: "a",
            load: () =>
              Effect.gen(function* () {
                if (++calls > 1) yield* Deferred.await(release)
                return catalog
              }),
          }),
      })
      yield* reader.read()
      yield* TestClock.adjust("1 hour")
      const first = yield* Effect.forkChild(reader.read())
      const second = yield* Effect.forkChild(reader.read())
      yield* Effect.yieldNow
      yield* Fiber.interrupt(first)
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(second)).toEqual(catalog)
      expect(calls).toBe(2)
    })
)
