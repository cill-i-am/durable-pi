import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"
import { expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber, ManagedRuntime } from "effect"
import { TestClock } from "effect/testing"
import { it as test, vi } from "vitest"

import {
  discoverCatalog,
  openaiCatalogSource,
} from "../src/inference/adapters/openai-catalog"
import { ownerCatalogSource } from "../src/inference/adapters/owner-catalog"
import {
  makeModelCatalog,
  catalogApplication,
  ModelCatalogReader,
  type CatalogSource,
} from "../src/inference/catalog"
import { ModelUnavailable } from "../src/inference/policy"
import { nativeOperation } from "../src/shared/interop"
import { account, catalog, credential } from "./inference-fixture"

const installed = openaiProvider().getModels()
const gate = <T = void>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}
const dies = <T, TError>(exit: Exit.Exit<T, TError>, defect: unknown) =>
  Exit.isFailure(exit) &&
  exit.cause.reasons.some(
    (reason) => reason._tag === "Die" && reason.defect === defect
  )

it.effect(
  "a new connection does not wait for obsolete in-flight discovery",
  () =>
    Effect.gen(function* () {
      const entered = gate(),
        release = gate()
      let identity = "old"
      const reader = yield* makeModelCatalog({
        current: () =>
          Effect.succeed({
            identity,
            load:
              identity === "old"
                ? () =>
                    Effect.promise(async () => {
                      entered.resolve()
                      await release.promise
                      return catalog
                    })
                : () => Effect.succeed(catalog),
          }),
      })
      const obsolete = yield* Effect.forkChild(reader.read())
      yield* Effect.promise(() => entered.promise)
      identity = "new"
      // This must complete while the old provider is still blocked.
      expect(yield* reader.read()).toEqual(catalog)
      release.resolve()
      expect((yield* Fiber.join(obsolete)).error).toContain("changed")
    })
)

it.effect(
  "catalog caches only successful reads and expires against invocation Clock",
  () =>
    Effect.gen(function* () {
      let key = "a",
        calls = 0
      const source: CatalogSource = {
        current: () =>
          Effect.succeed({
            identity: key,
            load: () =>
              Effect.sync(() => {
                calls++
                return catalog
              }),
          }),
      }
      const reader = yield* makeModelCatalog(source)
      yield* TestClock.setTime(20_000)
      expect(yield* reader.read()).toEqual(catalog)
      yield* TestClock.setTime(79_999)
      yield* reader.read()
      expect(calls).toBe(1)
      yield* TestClock.setTime(80_000)
      yield* reader.read()
      expect(calls).toBe(2)
      key = "b"
      yield* reader.read()
      expect(calls).toBe(3)
    })
)

it.effect(
  "catalog acquisition shares work through a permit without letting a cancelled waiter abort its owner",
  () =>
    Effect.gen(function* () {
      const entered = gate(),
        released = gate()
      let calls = 0
      const reader = yield* makeModelCatalog({
        current: () =>
          Effect.succeed({
            identity: "a",
            load: () =>
              Effect.promise(async () => {
                calls++
                entered.resolve()
                await released.promise
                return catalog
              }),
          }),
      })
      const first = yield* Effect.forkChild(reader.read())
      yield* Effect.promise(() => entered.promise)
      const waiting = yield* Effect.forkChild(reader.read())
      yield* Fiber.interrupt(waiting)
      expect(calls).toBe(1)
      released.resolve()
      expect(yield* Fiber.join(first)).toEqual(catalog)
      expect(yield* reader.read()).toEqual(catalog)
      expect(calls).toBe(1)
    })
)

it.effect(
  "an account change during lookup discards its result before publishing or caching it",
  () =>
    Effect.gen(function* () {
      const entered = gate(),
        release = gate()
      let key = "a",
        calls = 0
      const reader = yield* makeModelCatalog({
        current: () =>
          Effect.succeed({
            identity: key,
            load: () =>
              Effect.promise(async () => {
                calls++
                if (calls === 1) {
                  entered.resolve()
                  await release.promise
                }
                return catalog
              }),
          }),
      })
      const first = yield* Effect.forkChild(reader.read())
      yield* Effect.promise(() => entered.promise)
      key = "b"
      release.resolve()
      expect((yield* Fiber.join(first)).error).toContain("connection changed")
      expect(yield* reader.read()).toEqual(catalog)
      expect(calls).toBe(2)
    })
)

it.effect(
  "expected discovery failures remain safe, are never cached and cannot use an expired success",
  () =>
    Effect.gen(function* () {
      let fail = false,
        calls = 0
      const reader = yield* makeModelCatalog({
        current: () =>
          Effect.succeed({
            identity: "a",
            load: () => {
              calls++
              return fail
                ? Effect.fail(
                    new ModelUnavailable({ message: "Synthetic unavailable" })
                  )
                : Effect.succeed(catalog)
            },
          }),
      })
      yield* reader.read()
      yield* TestClock.adjust("60 seconds")
      fail = true
      expect((yield* reader.read()).models).toEqual([])
      expect((yield* reader.read()).error).toBe("Synthetic unavailable")
      expect(calls).toBe(3)
    })
)

it.effect(
  "a fatal discovery cleanup does not become a safe catalog error or a cached value",
  () =>
    Effect.gen(function* () {
      const defect = new Error("catalog cleanup")
      let calls = 0
      const reader = yield* makeModelCatalog({
        current: () =>
          Effect.succeed({
            identity: "a",
            load: () => {
              calls++
              return Effect.fail(
                new ModelUnavailable({ message: "ordinary unavailable" })
              ).pipe(Effect.ensuring(Effect.die(defect)))
            },
          }),
      })
      expect(dies(yield* reader.read().pipe(Effect.exit), defect)).toBe(true)
      expect(dies(yield* reader.read().pipe(Effect.exit), defect)).toBe(true)
      expect(calls).toBe(2)
    })
)

test("the local credential fingerprint changes across accounts sharing the same OAuth client and never exposes tokens", async () => {
  let current = credential
  const transport = vi.fn(async () => Response.json(account))
  const source = openaiCatalogSource(
    () => Effect.succeed(current),
    () => installed,
    transport
  )
  const first = await Effect.runPromise(source.current())
  current = { ...credential, access: "another-account-same-client" }
  const second = await Effect.runPromise(source.current())
  expect(first.identity).not.toBe(second.identity)
  expect(first.identity).toMatch(/^[a-f0-9]{64}$/)
  expect(JSON.stringify(first)).not.toContain(credential.access)
  const reader = await Effect.runPromise(makeModelCatalog(source))
  expect((await Effect.runPromise(reader.read())).error).toBeNull()
  current = credential
  expect((await Effect.runPromise(reader.read())).error).toBeNull()
  expect(transport).toHaveBeenCalledTimes(2)
})

it.effect(
  "owner forwarding does not add a second TTL and never reads a bot-local credential",
  () =>
    Effect.gen(function* () {
      let remote = 0,
        local = 0
      const source = ownerCatalogSource(
        () => Effect.succeed("owner"),
        async () => {
          remote++
          return catalog
        },
        {
          current: () => {
            local++
            return Effect.fail(
              new ModelUnavailable({ message: "Must not use local credential" })
            )
          },
        }
      )
      const reader = yield* makeModelCatalog(source)
      yield* reader.read()
      yield* reader.read()
      expect(remote).toBe(2)
      expect(local).toBe(0)
    })
)

it.effect(
  "a configured account reads its own catalog without recursively forwarding to itself",
  () =>
    Effect.gen(function* () {
      let local = 0,
        remote = 0
      const reader = yield* makeModelCatalog(
        ownerCatalogSource(
          () => Effect.succeed("self-account"),
          async () => {
            remote++
            throw new Error("Recursive account RPC")
          },
          {
            current: () => {
              local++
              return Effect.succeed({
                identity: "local-connection",
                load: () => Effect.succeed(catalog),
              })
            },
          },
          (owner) => owner === "self-account"
        )
      )
      expect(yield* reader.read()).toEqual(catalog)
      expect(local).toBeGreaterThan(0)
      expect(remote).toBe(0)
    })
)

it.effect(
  "owner/storage errors fail closed and accompanying defects remain observable",
  () =>
    Effect.gen(function* () {
      const defect = new Error("owner cleanup")
      const local: CatalogSource = {
        current: () => Effect.die("must not use local credentials"),
      }
      const reader = yield* makeModelCatalog(
        ownerCatalogSource(
          () => Effect.fail("storage"),
          async () => catalog,
          local
        )
      )
      expect((yield* reader.read()).models).toEqual([])
      const broken = yield* makeModelCatalog(
        ownerCatalogSource(
          () =>
            Effect.fail("storage").pipe(Effect.ensuring(Effect.die(defect))),
          async () => catalog,
          local
        )
      )
      expect(dies(yield* broken.read().pipe(Effect.exit), defect)).toBe(true)
      const invalid = yield* makeModelCatalog(
        ownerCatalogSource(
          () => Effect.succeed("owner"),
          async () => ({ models: "invalid" }),
          local
        )
      )
      expect((yield* invalid.read()).error).toContain("owner")
    })
)

it.effect(
  "native discovery timestamps use invocation Clock and safe status errors own their bodies",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(70_000)
      const value = yield* discoverCatalog(credential, installed, async () =>
        Response.json(account)
      )
      expect(value.checkedAt).toBe("1970-01-01T00:01:10.000Z")
      let cancelled = 0
      const failure = yield* discoverCatalog(
        credential,
        installed,
        async () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled++
              },
            }),
            { status: 429 }
          )
      ).pipe(Effect.result)
      expect(failure).toMatchObject({
        _tag: "Failure",
        failure: { message: expect.stringContaining("rate limited") },
      })
      expect(cancelled).toBe(1)
    })
)

for (const failed of [false, true])
  it.effect(
    `native discovery deadline joins late-response cleanup (cleanup fails: ${failed})`,
    () =>
      Effect.gen(function* () {
        const entered = gate(),
          response = gate<Response>(),
          cleaning = gate(),
          close = gate()
        const defect = new Error("late catalog release")
        let signal!: AbortSignal,
          settled = false
        const fiber = yield* Effect.forkChild(
          discoverCatalog(credential, installed, async (_url, options) => {
            signal = options!.signal!
            entered.resolve()
            return response.promise
          }).pipe(
            Effect.onExit(() =>
              Effect.sync(() => {
                settled = true
              })
            )
          )
        )
        yield* Effect.promise(() => entered.promise)
        try {
          yield* TestClock.adjust("15 seconds")
          expect(signal.aborted).toBe(true)
          expect(settled).toBe(false)
          response.resolve(
            new Response(
              new ReadableStream({
                async cancel() {
                  cleaning.resolve()
                  await close.promise
                  if (failed) throw defect
                },
              })
            )
          )
          yield* Effect.promise(() => cleaning.promise)
          expect(settled).toBe(false)
          close.resolve()
          const exit = yield* Fiber.await(fiber)
          expect(dies(exit, defect)).toBe(failed)
          if (!failed)
            expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(
              true
            )
        } finally {
          response.resolve(Response.json(account))
          close.resolve()
        }
      })
  )

test("native discovery bounds response bytes and preserves failed reader cleanup", async () => {
  const defect = new Error("catalog reader release")
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(1_048_577))
    },
    cancel() {
      throw defect
    },
  })
  const exit = await Effect.runPromiseExit(
    discoverCatalog(credential, installed, async () => new Response(body))
  )
  expect(dies(exit, defect)).toBe(true)
  expect(body.locked).toBe(false)
})

test("catalog disposal joins a late native response before the retained Layer closes", async () => {
  const entered = gate(),
    response = gate<Response>(),
    cleaning = gate(),
    close = gate()
  let signal!: AbortSignal
  const runtime = ManagedRuntime.make(
    catalogApplication(
      openaiCatalogSource(
        () => Effect.succeed(credential),
        () => installed,
        async (_url, options) => {
          signal = options!.signal!
          entered.resolve()
          return response.promise
        }
      )
    )
  )
  const work = runtime.runPromiseExit(
    Effect.flatMap(ModelCatalogReader, (reader) => reader.read())
  )
  await entered.promise
  let disposed = false
  const disposal = runtime.dispose().then(() => {
    disposed = true
  })
  expect(signal.aborted).toBe(true)
  response.resolve(
    new Response(
      new ReadableStream({
        async cancel() {
          cleaning.resolve()
          await close.promise
        },
      })
    )
  )
  await cleaning.promise
  expect(disposed).toBe(false)
  close.resolve()
  await disposal
  const exit = await work
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
})

test("late native rejection retains a classification defect after interruption", async () => {
  const entered = gate(),
    release = gate()
  const defect = new Error("native credential invariant")
  const controller = new AbortController()
  const work = Effect.runPromiseExit(
    nativeOperation(
      async () => {
        entered.resolve()
        await release.promise
        throw new Error("native failure")
      },
      () => {
        throw defect
      }
    ),
    { signal: controller.signal }
  )
  await entered.promise
  controller.abort()
  release.resolve()
  const exit = await work
  expect(dies(exit, defect)).toBe(true)
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
})

test("catalog redirects remain manual and their unread bodies are cancelled", async () => {
  let cancelled = 0
  const transport = vi.fn(
    async (_url: RequestInfo | URL, options?: RequestInit) => {
      expect(options?.redirect).toBe("manual")
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled++
          },
        }),
        { status: 307, headers: { location: "https://untrusted.test" } }
      )
    }
  )
  const result = await Effect.runPromise(
    discoverCatalog(credential, installed, transport).pipe(Effect.result)
  )
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ModelUnavailable" },
  })
  expect(transport).toHaveBeenCalledTimes(1)
  expect(cancelled).toBe(1)
})

test("an already-errored consumed body remains a checked transport failure without a second cancellation defect", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("private native read failure"))
    },
  })
  const exit = await Effect.runPromiseExit(
    discoverCatalog(credential, installed, async () => new Response(body))
  )
  expect(
    Exit.isFailure(exit) &&
      Cause.hasFails(exit.cause) &&
      !Cause.hasDies(exit.cause)
  ).toBe(true)
  expect(body.locked).toBe(false)
})
