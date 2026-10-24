import { it } from "@effect/vitest"
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Scope,
} from "effect"
import { expect } from "vitest"

import { makeModelCatalog } from "../src/inference/catalog"
import { ModelUnavailable } from "../src/inference/policy"
import { nativeOperation } from "../src/shared/interop"
import { catalog } from "./inference-fixture"

for (const withDefect of [false, true])
  it.effect(
    `joins and retains catalog refresh cleanup (defect=${withDefect})`,
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const started = yield* Deferred.make<void>()
        const aborted = yield* Deferred.make<void>()
        let reject!: (cause: unknown) => void
        const now = yield* Clock.currentTimeMillis
        const reader = yield* makeModelCatalog(
          {
            current: () =>
              Effect.succeed({
                identity: "a",
                load: () =>
                  nativeOperation(
                    (signal) =>
                      new Promise<typeof catalog>((_resolve, fail) => {
                        reject = fail
                        signal.addEventListener("abort", () =>
                          Effect.runSync(Deferred.succeed(aborted, undefined))
                        )
                        Effect.runSync(Deferred.succeed(started, undefined))
                      }),
                    (error) => error as ModelUnavailable
                  ),
              }),
          },
          {
            storage: {
              read: () =>
                Effect.succeed({
                  identity: "a",
                  verifiedAt: now - 300_001,
                  retryAt: now,
                  failures: 0,
                  value: catalog,
                }),
              write: () => Effect.void,
            },
          }
        ).pipe(Scope.provide(scope))
        expect(yield* reader.read()).toEqual(catalog)
        yield* Deferred.await(started)
        const closing = yield* Scope.close(scope, Exit.void).pipe(
          Effect.exit,
          Effect.forkChild
        )
        yield* Deferred.await(aborted)
        expect(closing.pollUnsafe()).toBeUndefined()
        const annotation = Context.makeUnsafe(
          new Map([["catalog-cleanup", "retained"]])
        )
        const checked = Cause.makeFailReason(
          new ModelUnavailable({ message: "cleanup failed" })
        ).annotate(annotation)
        const interrupted =
          Cause.makeInterruptReason(81726).annotate(annotation)
        const defect = Cause.makeDieReason("native cleanup defect").annotate(
          annotation
        )
        reject(
          Cause.fromReasons(
            withDefect ? [checked, defect, interrupted] : [checked, interrupted]
          )
        )
        const exit = yield* Fiber.join(closing)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const reasons = exit.cause.reasons
          const retainedFail = reasons.find(
            (reason) =>
              reason._tag === "Die" &&
              Cause.isReason(reason.defect) &&
              Cause.isFailReason(reason.defect)
          )
          expect(
            retainedFail?._tag === "Die" &&
              Cause.isReason(retainedFail.defect) &&
              Cause.isFailReason(retainedFail.defect) &&
              retainedFail.defect.error
          ).toBe(checked.error)
          expect(
            retainedFail?._tag === "Die" &&
              Cause.isReason(retainedFail.defect) &&
              Cause.isFailReason(retainedFail.defect) &&
              retainedFail.defect.annotations.get("catalog-cleanup")
          ).toBe("retained")
          expect(
            reasons.some(
              (reason) =>
                reason._tag === "Interrupt" &&
                reason.fiberId === 81726 &&
                reason.annotations.get("catalog-cleanup") === "retained"
            )
          ).toBe(true)
          if (withDefect)
            expect(
              reasons.some(
                (reason) =>
                  reason._tag === "Die" &&
                  reason.defect === "native cleanup defect" &&
                  reason.annotations.get("catalog-cleanup") === "retained"
              )
            ).toBe(true)
        }
        const after = yield* reader.read().pipe(Effect.exit)
        expect(
          Exit.isFailure(after) && Cause.hasInterruptsOnly(after.cause)
        ).toBe(true)
      })
  )
