import { describe, expect, it } from "vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Queue } from "effect"
import { TestClock } from "effect/testing"
import { database } from "./database"
import { makeSqliteMemory } from "../src/memory/adapters/sqlite"
import { MemoryRepository } from "../src/memory/repository"
import { byteLength, MemoryStorageError } from "../src/memory/domain"
import { SummaryFailure, SummaryModel } from "../src/memory/summary-model"
import {
  cutUtf8,
  pumpSummaries,
  summarize,
  SCALE,
} from "../src/memory/compaction"
import { piSummaryLayer } from "../src/memory/adapters/pi"

const long = {
  start: 0,
  count: 1,
  source: "user: " + "x".repeat(600),
  context: "older context",
}
const run = <T, TError>(effect: Effect.Effect<T, TError>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer())))

describe("Effect memory compaction", () => {
  it("uses an uncontaminated 512-byte ruler and UTF-8-safe feedback", () => {
    expect(SCALE).toBe("-".repeat(512))
    expect(byteLength(SCALE)).toBe(512)
    expect(cutUtf8("ab🍀z", 5)).toBe("ab")
    expect(cutUtf8("ab🍀z", 6)).toBe("ab🍀")
  })
  it("keeps short sources verbatim without a model call", () =>
    run(
      summarize({ ...long, source: "user: one\ntalk: two" }).pipe(
        Effect.provideService(SummaryModel, {
          complete: () => Effect.die("Must not call model"),
        }),
        Effect.tap((text) =>
          Effect.sync(() => expect(text).toBe("user: one\ntalk: two"))
        )
      )
    ))
  it("retries in one conversation and keeps the shortest of five", () =>
    run(
      Effect.gen(function* () {
        const lengths = [800, 600, 700, 550, 650],
          requests: number[] = [],
          feedback: string[] = []
        const result = yield* summarize(long).pipe(
          Effect.provideService(SummaryModel, {
            complete: (messages) =>
              Effect.sync(() => {
                requests.push(messages.length)
                if (messages.length > 1) feedback.push(messages.at(-1)!.text)
                return "x".repeat(lengths[requests.length - 1]!)
              }),
          })
        )
        expect(result).toHaveLength(550)
        expect(requests).toEqual([1, 3, 5, 7, 9])
        expect(feedback[0]).toContain("800 bytes")
        expect(feedback.every((text) => text.includes("| ← LIMIT"))).toBe(true)
      })
    ))
  it("rejects empty replies with a typed error", () =>
    run(
      Effect.gen(function* () {
        const error = yield* summarize(long).pipe(
          Effect.provideService(SummaryModel, {
            complete: () => Effect.succeed("  "),
          }),
          Effect.flip
        )
        expect(error).toMatchObject({ _tag: "SummaryFailure", reason: "empty" })
      })
    ))
  it("refills eight owned slots while preserving the leaf barrier", () =>
    run(
      Effect.gen(function* () {
        const memory = yield* makeSqliteMemory(database())
        for (let i = 0; i < 18; i++) {
          yield* memory.append(String(i), "user", "x".repeat(600))
          if (i < 16)
            yield* memory.saveNode({ start: i, count: 1 }, "s".repeat(300))
        }
        const started = yield* Queue.unbounded<void>()
        const release = yield* Deferred.make<void>()
        let active = 0,
          peak = 0
        const model = SummaryModel.of({
          complete: () =>
            Effect.gen(function* () {
              active++
              peak = Math.max(active, peak)
              yield* Queue.offer(started, undefined)
              yield* Deferred.await(release)
              return "summary"
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  active--
                })
              )
            ),
        })
        const fiber = yield* pumpSummaries().pipe(
          Effect.provideService(MemoryRepository, memory),
          Effect.provideService(SummaryModel, model),
          Effect.forkChild
        )
        for (let i = 0; i < 8; i++) yield* Queue.take(started)
        expect(yield* memory.next(new Set(["16+1"]))).not.toMatchObject({
          start: 17,
          count: 1,
        })
        expect(peak).toBe(8)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(fiber)
        expect(active).toBe(0)
        expect(yield* memory.settled()).toBe(true)
        expect(yield* memory.nodeCount()).toBe(34)
      })
    ))
  it("persists cooldowns across restart without recomputing completed nodes", () =>
    run(
      Effect.gen(function* () {
        const db = database(),
          memory = yield* makeSqliteMemory(db)
        yield* memory.append("a", "user", "x".repeat(600))
        yield* memory.append("b", "user", "next")
        let calls = 0
        const fail = SummaryModel.of({
          complete: () =>
            Effect.suspend(() => {
              calls++
              return new SummaryFailure({ reason: "unavailable" })
            }),
        })
        const pump = (
          repo: MemoryRepository["Service"],
          model: SummaryModel["Service"]
        ) =>
          pumpSummaries().pipe(
            Effect.provideService(MemoryRepository, repo),
            Effect.provideService(SummaryModel, model)
          )
        yield* TestClock.setTime(100)
        expect(yield* pump(memory, fail)).toBe(10_100)
        yield* TestClock.setTime(200)
        expect(yield* pump(yield* makeSqliteMemory(db), fail)).toBe(10_100)
        expect(calls).toBe(1)
        yield* TestClock.setTime(10_100)
        expect(yield* pump(memory, fail)).toBe(20_100)
        const good = SummaryModel.of({
          complete: () =>
            Effect.sync(() => {
              calls++
              return "summary"
            }),
        })
        yield* TestClock.setTime(20_100)
        expect(yield* pump(memory, good)).toBeUndefined()
        expect(yield* memory.render()).toContain("user: next")
        yield* pump(yield* makeSqliteMemory(db), good)
        expect(calls).toBe(3)
      })
    ))
  it("interrupts the Pi request on timeout and never persists a late reply", () =>
    run(
      Effect.gen(function* () {
        const memory = yield* makeSqliteMemory(database())
        yield* memory.append("a", "user", long.source)
        const started = yield* Deferred.make<void>()
        let signal: AbortSignal | undefined
        const layer = piSummaryLayer((_messages, abort) => {
          signal = abort
          Deferred.doneUnsafe(started, Effect.void)
          return new Promise(() => {})
        })
        const fiber = yield* pumpSummaries().pipe(
          Effect.provideService(MemoryRepository, memory),
          Effect.provide(layer),
          Effect.forkChild
        )
        yield* Deferred.await(started)
        yield* TestClock.adjust("60 seconds")
        expect(yield* Fiber.join(fiber)).toBe(70_000)
        expect(signal?.aborted).toBe(true)
        expect(yield* memory.nodeCount()).toBe(0)
      })
    ))
  it("aborts every child on cancellation without recording provider failures", () =>
    run(
      Effect.gen(function* () {
        const memory = yield* makeSqliteMemory(database())
        for (let i = 0; i < 16; i++) {
          yield* memory.append(String(i), "user", long.source)
          yield* memory.saveNode({ start: i, count: 1 }, "s".repeat(300))
        }
        const started = yield* Queue.unbounded<void>()
        let active = 0
        const model = SummaryModel.of({
          complete: () =>
            Effect.gen(function* () {
              active++
              yield* Queue.offer(started, undefined)
              return yield* Effect.never
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  active--
                })
              )
            ),
        })
        const fiber = yield* pumpSummaries().pipe(
          Effect.provideService(MemoryRepository, memory),
          Effect.provideService(SummaryModel, model),
          Effect.forkChild
        )
        for (let i = 0; i < 8; i++) yield* Queue.take(started)
        yield* Fiber.interrupt(fiber)
        expect(active).toBe(0)
        expect(yield* memory.retryAt()).toBeUndefined()
        expect(yield* memory.nodeCount()).toBe(16)
      })
    ))
  it("propagates storage failure and interrupts other requests without a retry marker", () =>
    run(
      Effect.gen(function* () {
        const memory = yield* makeSqliteMemory(database())
        for (let i = 0; i < 16; i++) {
          yield* memory.append(String(i), "user", long.source)
          yield* memory.saveNode({ start: i, count: 1 }, "s".repeat(300))
        }
        const started = yield* Queue.unbounded<void>(),
          release = yield* Deferred.make<void>()
        let active = 0,
          calls = 0
        const model = SummaryModel.of({
          complete: () =>
            Effect.gen(function* () {
              const first = calls++ === 0
              active++
              yield* Queue.offer(started, undefined)
              if (first) {
                yield* Deferred.await(release)
                return "summary"
              }
              return yield* Effect.never
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  active--
                })
              )
            ),
        })
        const fiber = yield* pumpSummaries().pipe(
          Effect.provideService(MemoryRepository, {
            ...memory,
            saveNode: () => new MemoryStorageError({ operation: "saveNode" }),
          }),
          Effect.provideService(SummaryModel, model),
          Effect.flip,
          Effect.forkChild
        )
        for (let i = 0; i < 8; i++) yield* Queue.take(started)
        yield* Deferred.succeed(release, undefined)
        expect(yield* Fiber.join(fiber)).toMatchObject({
          _tag: "MemoryStorageError",
        })
        expect(active).toBe(0)
        expect(yield* memory.retryAt()).toBeUndefined()
      })
    ))
})

it("propagates defects instead of recording a retryable provider failure", () =>
  run(
    Effect.gen(function* () {
      const memory = yield* makeSqliteMemory(database())
      yield* memory.append("a", "user", long.source)
      const exit = yield* pumpSummaries().pipe(
        Effect.provideService(MemoryRepository, memory),
        Effect.provideService(SummaryModel, {
          complete: () => Effect.die("summary implementation bug"),
        }),
        Effect.exit
      )
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(yield* memory.retryAt()).toBeUndefined()
    })
  ))
