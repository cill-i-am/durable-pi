import {
  fauxAssistantMessage,
  type AssistantMessage,
} from "@earendil-works/pi-ai"
import { Cause, Deferred, Effect, Exit, Layer, ManagedRuntime } from "effect"
import { expect, it } from "vitest"

import { bucketLayer } from "../src/memory/adapters/bucket"
import { webCryptoLayer } from "../src/memory/adapters/crypto"
import { piSummaryLayer } from "../src/memory/adapters/pi"
import {
  sqliteMemoryLayer,
  makeSqliteMemory,
} from "../src/memory/adapters/sqlite"
import { pumpSummaries } from "../src/memory/compaction"
import { MemoryStorageError } from "../src/memory/domain"
import { MemoryTransaction } from "../src/memory/ledger"
import { MemoryRepository } from "../src/memory/repository"
import { SummaryModel } from "../src/memory/summary-model"
import { database } from "./database"

it("supports synchronous host transactions and disposes active model requests", async () => {
  const db = database(),
    started = Deferred.makeUnsafe<void>()
  let signal: AbortSignal | undefined
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      sqliteMemoryLayer(db),
      webCryptoLayer,
      bucketLayer({
        get: async () => null,
        put: async () => ({ etag: "test" }),
      }),
      piSummaryLayer((_messages, abort) => {
        signal = abort
        Deferred.doneUnsafe(started, Effect.void)
        return new Promise((_resolve, reject) =>
          abort.addEventListener("abort", () => reject(abort.reason), {
            once: true,
          })
        )
      })
    )
  )
  try {
    const memory = runtime.runSync(MemoryRepository)
    const ledger = runtime.runSync(MemoryTransaction)
    await expect(
      runtime.runPromise(
        ledger.atomic(() =>
          Effect.gen(function* () {
            yield* ledger.append(
              "rolled-back",
              "user",
              "must roll back",
              "2026-09-01T00:00:00.000Z"
            )
            throw new Error("conversation admission failed")
          })
        )
      )
    ).rejects.toThrow("admission failed")
    expect(runtime.runSync(memory.total())).toBe(0)
    expect(db.all("SELECT * FROM memory_ready")).toHaveLength(0)
    runtime.runSync(memory.append("a", "user", "x".repeat(600)))
    const job = runtime.runPromiseExit(pumpSummaries())
    await Effect.runPromise(Deferred.await(started))
    await runtime.dispose()
    expect(Exit.isFailure(await job)).toBe(true)
    expect(signal?.aborted).toBe(true)
    expect(db.all("SELECT * FROM memory_nodes")).toHaveLength(0)
    expect(db.all("SELECT * FROM memory_failures")).toMatchObject([
      { attempts: 1 },
    ])
    expect(
      JSON.parse(
        db.all<{ control: string }>("SELECT control FROM memory_ready")[0]!
          .control
      )
    ).toMatchObject({ state: "paused", pauseReason: "uncertain", attempts: 1 })
  } finally {
    await runtime.dispose()
  }
})

it("actor disposal joins a noncooperative summary before releasing Layers and drops its late answer", async () => {
  const db = database(),
    events: string[] = []
  let release!: (reply: AssistantMessage) => void,
    entered!: () => void,
    aborted!: () => void
  const waiting = new Promise<AssistantMessage>((resolve) => {
      release = resolve
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve
    }),
    cancellation = new Promise<void>((resolve) => {
      aborted = resolve
    })
  let disposed = false
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      sqliteMemoryLayer(db),
      Layer.effectDiscard(
        Effect.addFinalizer(() =>
          Effect.sync(() => {
            events.push("layer.closed")
          })
        )
      ),
      piSummaryLayer((_messages, signal) => {
        signal.addEventListener("abort", aborted, { once: true })
        entered()
        return waiting.then((reply) => {
          events.push("request.settled")
          return reply
        })
      })
    )
  )
  let work: Promise<Exit.Exit<number | undefined, unknown>> | undefined
  try {
    const memory = runtime.runSync(MemoryRepository)
    await runtime.runPromise(memory.append("source", "user", "x".repeat(600)))
    work = runtime.runPromiseExit(pumpSummaries())
    await started
    const closing = runtime.dispose().then(() => {
      disposed = true
    })
    await cancellation
    expect(disposed).toBe(false)
    expect(events).toEqual([])
    expect(
      JSON.parse(
        db.all<{ control: string }>("SELECT control FROM memory_ready")[0]!
          .control
      )
    ).toMatchObject({ state: "claimed", attempts: 1 })
    release(fauxAssistantMessage("Late summary"))
    await closing
    const exit = await work
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(events).toEqual(["request.settled", "layer.closed"])
    expect(db.all("SELECT * FROM memory_nodes")).toEqual([])
    expect(db.all("SELECT * FROM memory_failures")).toMatchObject([
      { attempts: 1 },
    ])
    expect(
      JSON.parse(
        db.all<{ control: string }>("SELECT control FROM memory_ready")[0]!
          .control
      )
    ).toMatchObject({ state: "paused", pauseReason: "uncertain", attempts: 1 })
    expect(db.all("SELECT * FROM memory_ready")).toHaveLength(1)
  } finally {
    release(fauxAssistantMessage("Cleanup"))
    await runtime.dispose()
    await work
  }
})
it("summary storage failures propagate and pause the owned attempt without automatic replay", async () => {
  const db = database(),
    memory = await Effect.runPromise(makeSqliteMemory(db))
  await Effect.runPromise(memory.append("source", "user", "x".repeat(600)))
  const result = await Effect.runPromise(
    pumpSummaries().pipe(
      Effect.provideService(MemoryRepository, memory),
      Effect.provide(
        piSummaryLayer(() =>
          Promise.reject(new MemoryStorageError({ operation: "summary route" }))
        )
      ),
      Effect.result
    )
  )
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "MemoryStorageError", operation: "summary route" },
  })
  expect(db.all("SELECT * FROM memory_failures")).toMatchObject([
    { attempts: 1 },
  ])
  expect(
    JSON.parse(
      db.all<{ control: string }>("SELECT control FROM memory_ready")[0]!
        .control
    )
  ).toMatchObject({ state: "paused", pauseReason: "uncertain", attempts: 1 })
  expect(db.all("SELECT * FROM memory_nodes")).toEqual([])
})
it("synchronous summary callback and result interpretation failures remain defects", async () => {
  const job = { start: 0, count: 1, source: "source", context: "" }
  for (const callback of [
    () => {
      throw new Error("Programmer failure")
    },
    () => {
      const reply = fauxAssistantMessage("Reply")
      Object.defineProperty(reply, "content", {
        get: () => {
          throw new Error("Decoder failure")
        },
      })
      return Promise.resolve(reply)
    },
    () => Promise.reject(new SyntaxError("Invalid stored route JSON")),
  ]) {
    const exit = await Effect.runPromise(
      Effect.flatMap(SummaryModel, (model) => model.complete([], job)).pipe(
        Effect.provide(piSummaryLayer(callback)),
        Effect.exit
      )
    )
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
  }
})
