import { it } from "@effect/vitest"
import { Cause, Context, Deferred, Effect, Exit, Fiber } from "effect"
import { expect } from "vitest"

import { nativeOperation } from "../src/shared/interop"

it.effect(
  "retains a late raw native Fail plus annotated Interrupt after the interrupted owner joins",
  () =>
    Effect.gen(function* () {
      class Marker extends Context.Service<Marker, string>()(
        "NativeJoinMarker"
      ) {}
      const entered = yield* Deferred.make<void>(),
        aborted = yield* Deferred.make<void>()
      let reject!: (cause: unknown) => void
      const fiber = yield* nativeOperation(
        (signal) =>
          new Promise<void>((_, fail) => {
            reject = fail
            signal.addEventListener("abort", () =>
              Effect.runSync(Deferred.succeed(aborted, undefined))
            )
            Effect.runSync(Deferred.succeed(entered, undefined))
          }),
        (cause) => cause
      ).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const joining = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
      yield* Deferred.await(aborted)
      expect(joining.pollUnsafe()).toBeUndefined()
      reject(
        Cause.fromReasons([
          Cause.makeFailReason("native checked failure").annotate(
            Context.make(Marker, "failure")
          ),
          Cause.makeInterruptReason(91234).annotate(
            Context.make(Marker, "interrupt")
          ),
        ])
      )
      yield* Fiber.join(joining)
      const result = yield* Fiber.await(fiber)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        expect(
          result.cause.reasons.some(
            (reason) =>
              reason._tag === "Interrupt" &&
              reason.fiberId === 91234 &&
              reason.annotations.get(Marker.key) === "interrupt"
          )
        ).toBe(true)
        expect(
          result.cause.reasons.some(
            (reason) =>
              reason._tag === "Die" &&
              typeof reason.defect === "object" &&
              reason.defect !== null &&
              "_tag" in reason.defect &&
              reason.defect._tag === "Fail" &&
              "error" in reason.defect &&
              reason.defect.error === "native checked failure" &&
              "annotations" in reason.defect &&
              (reason.defect.annotations as ReadonlyMap<string, unknown>).get(
                Marker.key
              ) === "failure"
          )
        ).toBe(true)
      }
    })
)
for (const failure of [
  new DOMException("Aborted", "AbortError"),
  Cause.interrupt(91235),
]) {
  it.effect(
    `keeps ordinary cancellation quiet: ${Cause.isCause(failure) ? "pure native interruption" : "AbortError"}`,
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const fiber = yield* nativeOperation(
          (signal) =>
            new Promise<void>((_, reject) => {
              signal.addEventListener("abort", () => reject(failure))
              Effect.runSync(Deferred.succeed(entered, undefined))
            }),
          (cause) => cause
        ).pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(fiber)
        const result = yield* Fiber.await(fiber)
        expect(
          Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)
        ).toBe(true)
      })
  )
}
