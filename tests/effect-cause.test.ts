import { it as effectIt } from "@effect/vitest"
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Schema,
} from "effect"
import { TestClock } from "effect/testing"
import { expect, expectTypeOf, it } from "vitest"

import { observeCleanup, orDieAll, preserveFatal } from "../src/shared/effect"

class Expected extends Schema.TaggedError<Expected>()("Expected", {
  message: Schema.String,
}) {}
class Invocation extends Context.Service<Invocation, string>()(
  "CauseInvocation"
) {}
const recoveries: ReadonlyArray<{
  name: string
  recover: (
    work: Effect.Effect<never, Expected, Invocation>,
    called: () => void
  ) => Effect.Effect<void, Expected, Invocation>
}> = [
  {
    name: "catch",
    recover: (work, called) =>
      work.pipe(Effect.catch(() => Effect.sync(called))),
  },
  {
    name: "catchTag",
    recover: (work, called) =>
      work.pipe(Effect.catchTag("Expected", () => Effect.sync(called))),
  },
  {
    name: "mapError",
    recover: (work, called) =>
      work.pipe(
        Effect.mapError((error) => {
          called()
          return error
        })
      ),
  },
  { name: "orDie", recover: (work) => work.pipe(Effect.orDie) },
  {
    name: "result",
    recover: (work, called) =>
      work.pipe(
        Effect.result,
        Effect.tap(() => Effect.sync(called)),
        Effect.asVoid
      ),
  },
  {
    name: "match",
    recover: (work, called) =>
      work.pipe(Effect.match({ onFailure: called, onSuccess: called })),
  },
]

for (const mode of ["defect", "interruption"] as const)
  it.each(recoveries)(
    `preserves a compound ${mode} before $name without running recovery`,
    async ({ recover }) => {
      const cleanup = new Error("Private cleanup failure"),
        seen: string[] = []
      let called = false
      const work = Effect.gen(function* () {
        seen.push(yield* Invocation)
        return yield* new Expected({ message: "Expected operation failure" })
      }).pipe(
        Effect.ensuring(
          mode === "defect" ? Effect.die(cleanup) : Effect.interrupt
        )
      )
      const exit = await Effect.runPromiseExit(
        recover(work.pipe(preserveFatal), () => {
          called = true
        }).pipe(Effect.provideService(Invocation, "caller context"))
      )
      expect(seen).toEqual(["caller context"])
      expect(called).toBe(false)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
      if (mode === "defect")
        expect(
          Exit.isFailure(exit) &&
            exit.cause.reasons.some(
              (reason) => reason._tag === "Die" && reason.defect === cleanup
            )
        ).toBe(true)
      else
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(
          true
        )
    }
  )

it("retains exact success, error and invocation requirements in the shared operations", () => {
  const work = Effect.gen(function* () {
    yield* Invocation
    return yield* new Expected({ message: "Rejected" })
  })
  expectTypeOf(work.pipe(preserveFatal)).toEqualTypeOf<
    Effect.Effect<never, Expected, Invocation>
  >()
  expectTypeOf(work.pipe(orDieAll)).toEqualTypeOf<
    Effect.Effect<never, never, Invocation>
  >()
  expectTypeOf(
    observeCleanup(work, (observed) =>
      observed.pipe(Effect.timeout("1 second"))
    )
  ).toEqualTypeOf<
    Effect.Effect<never, Expected | Cause.TimeoutError, Invocation>
  >()
})

it("retains ordinary expected recovery and all annotated reasons during fatal conversion", async () => {
  const expected = new Expected({ message: "Ordinary rejection" })
  expect(
    await Effect.runPromise(
      Effect.fail(expected).pipe(
        preserveFatal,
        Effect.catchTag("Expected", (error) => Effect.succeed(error))
      )
    )
  ).toBe(expected)
  const fail = Cause.makeFailReason(expected),
    die = Cause.makeDieReason(new Error("Private failure")),
    interrupt = Cause.makeInterruptReason(987)
  const exit = await Effect.runPromiseExit(
    Effect.failCause(Cause.fromReasons([fail, die, interrupt])).pipe(orDieAll)
  )
  expect(Exit.isFailure(exit) && exit.cause.reasons).toContain(die)
  expect(Exit.isFailure(exit) && exit.cause.reasons).toContain(interrupt)
  expect(
    Exit.isFailure(exit) &&
      exit.cause.reasons.some(
        (reason) => reason._tag === "Die" && reason.defect === fail
      )
  ).toBe(true)
})

effectIt.effect(
  "native deadlines retain losing-child cleanup defects and invocation Clock",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>(),
          cleanup = new Error("Private deadline cleanup failure")
        const work = Effect.acquireUseRelease(
          Deferred.succeed(entered, undefined),
          () => Effect.never,
          () => Effect.die(cleanup)
        )
        const fiber = yield* observeCleanup(work, (observed) =>
          observed.pipe(Effect.timeout("1 second"))
        ).pipe(Effect.exit, Effect.forkScoped)
        yield* Deferred.await(entered)
        yield* TestClock.adjust("1 second")
        const exit = yield* Fiber.join(fiber)
        expect(
          Exit.isFailure(exit) &&
            exit.cause.reasons.some(
              (reason) => reason._tag === "Die" && reason.defect === cleanup
            )
        ).toBe(true)
        expect(yield* Clock.currentTimeMillis).toBe(1000)
      })
    )
)

effectIt.effect(
  "external interruption retains the cleanup defect of a timed child",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>(),
          cleanup = new Error("Private interrupted cleanup failure")
        const work = Effect.acquireUseRelease(
          Deferred.succeed(entered, undefined),
          () => Effect.never,
          () => Effect.die(cleanup)
        )
        const fiber = yield* observeCleanup(work, (observed) =>
          observed.pipe(Effect.timeout("1 hour"))
        ).pipe(Effect.forkScoped)
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(
          true
        )
        expect(
          Exit.isFailure(exit) &&
            exit.cause.reasons.some(
              (reason) => reason._tag === "Die" && reason.defect === cleanup
            )
        ).toBe(true)
      })
    )
)

it.each(["timeout", "race"])(
  "does not invent another fatal reason when %s returns the observed failure",
  async (mode) => {
    const refused = Cause.makeFailReason(
      new Expected({ message: "Original rejection" })
    )
    const defect = Cause.makeDieReason(new Error("Original defect"))
    const original = Cause.fromReasons([refused, defect])
    const exit = await Effect.runPromiseExit(
      observeCleanup(Effect.failCause(original), (observed) =>
        mode === "timeout"
          ? Effect.timeout(observed, "1 hour")
          : Effect.raceFirst(observed, Effect.never)
      )
    )
    expect(Exit.isFailure(exit) && exit.cause.reasons).toEqual([
      refused,
      defect,
    ])
  }
)

it("does not restore an old checked error after the operator maps the winning failure", async () => {
  const original = new Expected({ message: "Original rejection" })
  const mapped = new Expected({ message: "Mapped rejection" })
  const defect = Cause.makeDieReason(new Error("Retained defect"))
  const exit = await Effect.runPromiseExit(
    observeCleanup(
      Effect.failCause(
        Cause.fromReasons([Cause.makeFailReason(original), defect])
      ),
      (observed) =>
        observed.pipe(
          Effect.timeout("1 hour"),
          Effect.catchCause((cause) =>
            Effect.failCause(Cause.map(cause, () => mapped))
          )
        )
    )
  )
  expect(Exit.isFailure(exit) && exit.cause.reasons).toEqual([
    Cause.makeFailReason(mapped),
    defect,
  ])
})

it("reattaches only missing reasons when a native operator retains part of a failed Cause", async () => {
  class Marker extends Context.Service<Marker, string>()(
    "CleanupReasonMarker"
  ) {}
  const refused = Cause.makeFailReason(
    new Expected({ message: "Original rejection" })
  ).annotate(Context.make(Marker, "failure"))
  const retained = Cause.makeDieReason(new Error("Retained defect"))
  const missing = Cause.makeDieReason(
    new Error("Missing native cleanup")
  ).annotate(Context.make(Marker, "cleanup"))
  const exit = await Effect.runPromiseExit(
    observeCleanup(
      Effect.failCause(Cause.fromReasons([refused, retained, missing])),
      (observed) =>
        observed.pipe(
          Effect.catchCause(() =>
            Effect.failCause(Cause.fromReasons([retained]))
          )
        )
    )
  )
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect(exit.cause.reasons).toEqual([
      retained,
      Cause.makeDieReason(refused),
      missing,
    ])
    expect(
      exit.cause.reasons
        .find(
          (reason) => reason._tag === "Die" && reason.defect === missing.defect
        )
        ?.annotations.get(Marker.key)
    ).toBe("cleanup")
  }
})
