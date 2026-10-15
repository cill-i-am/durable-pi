import { expect, it } from "@effect/vitest"
import { it as test } from "vitest"
import { Effect, Fiber, ManagedRuntime } from "effect"
import { TestClock } from "effect/testing"
import {
  TerminalAuthoritySync,
  terminalAuthoritySyncLayer,
} from "../src/agents/adapters/synchronization"

const projection = { revision: 3, active: true }
const gate = () => {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

it.effect(
  "reuses a successful acknowledgment for an identical projection until its bounded TTL",
  () => {
    let calls = 0
    return Effect.gen(function* () {
      const sync = yield* TerminalAuthoritySync
      yield* TestClock.setTime(0)
      yield* sync.sync(projection)
      yield* sync.sync({ ...projection })
      yield* TestClock.setTime(59_999)
      yield* sync.sync(projection)
      expect(calls).toBe(1)
      yield* TestClock.setTime(60_000)
      yield* sync.sync(projection)
      expect(calls).toBe(2)
    }).pipe(
      Effect.provide(
        terminalAuthoritySyncLayer(
          {
            fetch: async () => {
              calls++
              return new Response(null, { status: 204 })
            },
          },
          "actor"
        )
      )
    )
  }
)

it.effect("does not cache failed terminal acknowledgments", () => {
  let calls = 0
  return Effect.gen(function* () {
    const sync = yield* TerminalAuthoritySync
    expect((yield* Effect.flip(sync.sync(projection)))._tag).toBe(
      "AgentSynchronizationError"
    )
    yield* sync.sync(projection)
    yield* sync.sync(projection)
    expect(calls).toBe(2)
  }).pipe(
    Effect.provide(
      terminalAuthoritySyncLayer(
        {
          fetch: async () =>
            new Response(null, { status: ++calls === 1 ? 503 : 204 }),
        },
        "actor"
      )
    )
  )
})

it.effect(
  "changed authority and a late archive fence each require a new acknowledgment",
  () => {
    const seen: unknown[] = []
    return Effect.gen(function* () {
      const sync = yield* TerminalAuthoritySync
      yield* sync.sync(projection)
      yield* sync.sync({ ...projection, revokeThrough: 2 })
      yield* sync.sync({ revision: 4, active: false, revokeThrough: 4 })
      yield* sync.sync({ revision: 5, active: true })
      expect(seen).toEqual([
        projection,
        { ...projection, revokeThrough: 2 },
        { revision: 4, active: false, revokeThrough: 4 },
        { revision: 5, active: true },
      ])
    }).pipe(
      Effect.provide(
        terminalAuthoritySyncLayer(
          {
            fetch: async (request) => {
              seen.push(await request.json())
              return new Response(null, { status: 204 })
            },
          },
          "actor"
        )
      )
    )
  }
)

it.effect(
  "concurrent identical projections share one pending acknowledgment",
  () => {
    const entered = gate(),
      release = gate()
    let calls = 0
    return Effect.gen(function* () {
      const sync = yield* TerminalAuthoritySync
      const first = yield* sync.sync(projection).pipe(Effect.forkChild)
      yield* Effect.promise(() => entered.promise)
      const waiting = yield* sync.sync(projection).pipe(Effect.forkChild)
      yield* Fiber.interrupt(waiting)
      expect(calls).toBe(1)
      release.resolve()
      yield* Fiber.join(first)
      yield* sync.sync(projection)
      expect(calls).toBe(1)
    }).pipe(
      Effect.provide(
        terminalAuthoritySyncLayer(
          {
            fetch: async () => {
              calls++
              entered.resolve()
              await release.promise
              return new Response(null, { status: 204 })
            },
          },
          "actor"
        )
      )
    )
  }
)

it.effect(
  "newer revocation does not queue behind an older pending projection",
  () => {
    const entered = gate(),
      release = gate()
    let calls = 0
    return Effect.gen(function* () {
      const sync = yield* TerminalAuthoritySync
      const old = yield* sync.sync(projection).pipe(Effect.forkChild)
      yield* Effect.promise(() => entered.promise)
      const archived = { revision: 4, active: false, revokeThrough: 4 }
      yield* sync.sync(archived)
      expect(calls).toBe(2)
      release.resolve()
      yield* Fiber.join(old)
      yield* sync.sync(archived)
      expect(calls).toBe(2)
    }).pipe(
      Effect.provide(
        terminalAuthoritySyncLayer(
          {
            fetch: async () => {
              if (++calls === 1) {
                entered.resolve()
                await release.promise
              }
              return new Response(null, { status: 204 })
            },
          },
          "actor"
        )
      )
    )
  }
)

test("a fresh actor runtime acknowledges again and never shares another actor's cache", async () => {
  const actors: string[] = []
  const binding = {
    fetch: async (request: Request) => {
      actors.push(new URL(request.url).pathname.split("/")[1]!)
      return new Response(null, { status: 204 })
    },
  }
  for (const actor of ["first", "second", "first"]) {
    const runtime = ManagedRuntime.make(
      terminalAuthoritySyncLayer(binding, actor)
    )
    try {
      await runtime.runPromise(
        Effect.flatMap(TerminalAuthoritySync, (sync) => sync.sync(projection))
      )
    } finally {
      await runtime.dispose()
    }
  }
  expect(actors).toEqual(["first", "second", "first"])
})
