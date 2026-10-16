import { expect, it } from "@effect/vitest"
import { Cause, Clock, Context, Deferred, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { vi } from "vitest"

import { accountCredentials } from "../src/inference/adapters/credentials-pi"
import { resolveRoute, type ResolvedRoute } from "../src/inference/policy"
import { SummaryRoutes } from "../src/memory/adapters/model-routes"
import { piModelSummaryProvider } from "../src/memory/adapters/pi-model"
import { MemoryStorageError } from "../src/memory/domain"
import {
  SummaryRouting,
  summaryRoutingApplication,
} from "../src/memory/routing"
import {
  makeSummaryModel,
  type SummaryInputs,
  type SummaryProvider,
} from "../src/memory/summary-execution"
import { database } from "./database"
import { catalog, credential, response } from "./inference-fixture"
import { modelStart } from "./models-fixture"

vi.mock("cloudflare:workers", () => ({ env: {}, tracing: undefined }))
const job = { start: 0, count: 1, source: "Original", context: "" }
const fixture = Effect.gen(function* () {
  const db = database(),
    ledger = new SummaryRoutes(db),
    routing = yield* SummaryRouting.pipe(
      Effect.provide(summaryRoutingApplication(ledger))
    ),
    dispatched: ResolvedRoute[] = []
  const inputs: SummaryInputs = {
    settings: () => Effect.succeed(undefined),
    catalog: () => Effect.succeed(catalog),
  }
  const provider: SummaryProvider = {
    prepare: (route) =>
      Effect.succeed({
        complete: () =>
          Effect.sync(() => {
            dispatched.push(route)
            return "Summary"
          }),
      }),
  }
  const model = makeSummaryModel(routing, inputs, provider)
  return {
    db,
    ledger,
    routing,
    inputs,
    provider,
    model,
    dispatched,
    requests: () =>
      db
        .all<{ requests: number }>(
          "SELECT requests FROM summary_routes ORDER BY revision"
        )
        .map((row) => row.requests),
  }
})
it.effect(
  "summary requests retain their independent pinned route and bounded account context",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      expect(yield* f.model.complete([], job)).toBe("Summary")
      f.inputs.settings = () =>
        Effect.succeed({ model: "gpt-6-astra", thinking: "high" })
      yield* f.model.complete([], job)
      expect(f.dispatched.map((route) => route.model)).toEqual([
        "gpt-6-luna",
        "gpt-6-luna",
      ])
      expect(f.dispatched[0]?.contextWindow).toBe(272000)
      expect(f.requests()).toEqual([2])
    })
)
it.effect(
  "a replacement during discovery receives neither the old budget nor a request debit",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      f.inputs.catalog = () =>
        Effect.sync(() => {
          Effect.runSync(
            f.ledger.replace(
              job,
              "newer",
              resolveRoute("memory", {
                model: "gpt-6.1-sol",
                thinking: "medium",
              })
            )
          )
          return catalog
        })
      expect(
        yield* f.model.complete([], job).pipe(Effect.result)
      ).toMatchObject({ _tag: "Failure", failure: { _tag: "InvalidMemory" } })
      expect(f.requests()).toEqual([0, 0])
      expect(
        Effect.runSync(f.ledger.current(job))?.contextWindow
      ).toBeUndefined()
      expect(f.dispatched).toEqual([])
    })
)
it.effect(
  "replacement after native preparation is fenced before request admission",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        prepare = f.provider.prepare
      f.provider.prepare = (route, part) =>
        Effect.sync(() => {
          Effect.runSync(
            f.ledger.replace(part, "newer", resolveRoute("memory"))
          )
        }).pipe(Effect.andThen(prepare(route, part)))
      expect(
        yield* f.model.complete([], job).pipe(Effect.result)
      ).toMatchObject({ _tag: "Failure", failure: { _tag: "InvalidMemory" } })
      expect(f.requests()).toEqual([0, 0])
      expect(f.dispatched).toEqual([])
    })
)
it.effect(
  "the fifteen-request limit survives restart and admits exactly fifteen dispatches",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      for (let n = 0; n < 15; n++) yield* f.model.complete([], job)
      const reopened = yield* SummaryRouting.pipe(
        Effect.provide(summaryRoutingApplication(new SummaryRoutes(f.db)))
      )
      const model = makeSummaryModel(reopened, f.inputs, f.provider)
      expect(yield* model.complete([], job).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "SummaryFailure", reason: "unavailable" },
      })
      expect(f.requests()).toEqual([15])
      expect(f.dispatched).toHaveLength(15)
    })
)
it.effect(
  "failed request debit never dispatches and leaves its counter unchanged",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      f.db.run(
        "CREATE TRIGGER reject_debit BEFORE UPDATE OF requests ON summary_routes BEGIN SELECT RAISE(ABORT,'private data'); END"
      )
      expect(
        yield* f.model.complete([], job).pipe(Effect.result)
      ).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "MemoryStorageError" },
      })
      expect(f.requests()).toEqual([0])
      expect(f.dispatched).toEqual([])
    })
)
it.effect("canceled discovery never debits or dispatches when released", () =>
  Effect.gen(function* () {
    const f = yield* fixture,
      entered = yield* Deferred.make<void>(),
      release = yield* Deferred.make<void>()
    f.inputs.catalog = () =>
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as(catalog)
      )
    const pending = yield* f.model.complete([], job).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    yield* Fiber.interrupt(pending)
    yield* Deferred.succeed(release, undefined)
    expect(f.requests()).toEqual([0])
    expect(f.dispatched).toEqual([])
  })
)
it.effect(
  "the SDK catalog callback inherits caller Context and Clock and returns typed source failure intact",
  () =>
    Effect.gen(function* () {
      class Request extends Context.Service<Request, { value: string }>()(
        "test/SummarySdkRequest"
      ) {}
      const seen: string[] = [],
        times: number[] = []
      const provider = piModelSummaryProvider(
        {
          credentials: () => accountCredentials(async () => credential),
          options: (route) => ({
            start: modelStart(),
            contextWindow: () => route.contextWindow,
          }),
          systemPrompt: "Synthetic",
          tools: () => [],
        },
        () =>
          Effect.gen(function* () {
            seen.push((yield* Request).value)
            times.push(yield* Clock.currentTimeMillis)
            return yield* Effect.fail(
              new MemoryStorageError({ operation: "current catalog" })
            )
          })
      )
      let fetches = 0
      vi.stubGlobal("fetch", async () => {
        fetches++
        return response("gpt-6-luna")
      })
      try {
        yield* TestClock.setTime(35000)
        const result = yield* Effect.gen(function* () {
          const prepared = yield* provider.prepare(
            { ...resolveRoute("memory"), contextWindow: 272000 },
            job
          )
          return yield* prepared
            .complete([{ role: "user", text: "Source" }], job)
            .pipe(Effect.result)
        }).pipe(Effect.provideService(Request, { value: "this invocation" }))
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "MemoryStorageError", operation: "current catalog" },
        })
        expect(seen).toEqual(["this invocation"])
        expect(times).toEqual([35000])
        expect(fetches).toBe(0)
      } finally {
        vi.unstubAllGlobals()
      }
    })
)
it.effect(
  "caller interruption reaches the SDK catalog callback before dispatch",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      let interrupted = false,
        fetches = 0
      const provider = piModelSummaryProvider(
        {
          credentials: () => accountCredentials(async () => credential),
          options: (route) => ({
            start: modelStart(),
            contextWindow: () => route.contextWindow,
          }),
          systemPrompt: "Synthetic",
          tools: () => [],
        },
        () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(catalog),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true
              })
            )
          )
      )
      vi.stubGlobal("fetch", async () => {
        fetches++
        return response("gpt-6-luna")
      })
      try {
        const prepared = yield* provider.prepare(
          { ...resolveRoute("memory"), contextWindow: 272000 },
          job
        )
        const pending = yield* prepared
          .complete([{ role: "user", text: "Source" }], job)
          .pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(pending)
        const exit = yield* Fiber.await(pending)
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(
          true
        )
        expect(interrupted).toBe(true)
        expect(fetches).toBe(0)
      } finally {
        vi.unstubAllGlobals()
      }
    })
)
it.effect(
  "the SDK cannot flatten catalog defects into provider unavailability",
  () =>
    Effect.gen(function* () {
      const defect = new Error("Programming defect")
      const provider = piModelSummaryProvider(
        {
          credentials: () => accountCredentials(async () => credential),
          options: (route) => ({
            start: modelStart(),
            contextWindow: () => route.contextWindow,
          }),
          systemPrompt: "Synthetic",
          tools: () => [],
        },
        () => Effect.die(defect)
      )
      let fetches = 0
      vi.stubGlobal("fetch", async () => {
        fetches++
        return response("gpt-6-luna")
      })
      try {
        const prepared = yield* provider.prepare(
          { ...resolveRoute("memory"), contextWindow: 272000 },
          job
        )
        const exit = yield* prepared
          .complete([{ role: "user", text: "Source" }], job)
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
        expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
        expect(fetches).toBe(0)
      } finally {
        vi.unstubAllGlobals()
      }
    })
)
