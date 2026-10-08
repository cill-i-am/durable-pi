import { expect, it } from "vitest"
import { Deferred, Effect, Exit, Layer, ManagedRuntime } from "effect"
import { database } from "./database"
import { MemoryRepository } from "../src/memory/repository"
import { sqliteMemoryLayer } from "../src/memory/adapters/sqlite"
import { piSummaryLayer } from "../src/memory/adapters/pi"
import { bucketLayer } from "../src/memory/adapters/bucket"
import { webCryptoLayer } from "../src/memory/adapters/crypto"
import { pumpSummaries } from "../src/memory/compaction"

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
        return new Promise(() => {})
      })
    )
  )
  try {
    // This is the same cold, synchronous Layer acquisition used by the host.
    const memory = runtime.runSync(MemoryRepository)
    expect(() =>
      db.transaction(() => {
        runtime.runSync(memory.append("rolled-back", "user", "must roll back"))
        throw new Error("conversation admission failed")
      })
    ).toThrow("admission failed")
    expect(runtime.runSync(memory.total())).toBe(0)
    expect(db.all("SELECT * FROM memory_ready")).toHaveLength(0)
    runtime.runSync(memory.append("a", "user", "x".repeat(600)))
    const job = runtime.runPromiseExit(pumpSummaries())
    await Effect.runPromise(Deferred.await(started))
    await runtime.dispose()
    expect(Exit.isFailure(await job)).toBe(true)
    expect(signal?.aborted).toBe(true)
    expect(db.all("SELECT * FROM memory_nodes")).toHaveLength(0)
    expect(db.all("SELECT * FROM memory_failures")).toHaveLength(0)
  } finally {
    await runtime.dispose()
  }
})
