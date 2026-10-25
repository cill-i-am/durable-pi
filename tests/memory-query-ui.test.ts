import { it } from "@effect/vitest"
import { send, waitFor } from "@xstate/effect"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"

import {
  makeMemoryQuery,
  memoryQueryRead,
} from "../src/features/memory/query-owner"
import type {
  MemoryQuery,
  MemoryQueryData,
} from "../src/features/memory/query.machine"

const empty: MemoryQueryData = {
  results: [],
  parts: [],
  original: null,
  trail: [],
}
const part = { start: 1, count: 2, text: "summary" }

it.effect(
  "inactive search does not read and failed search only retries explicitly",
  () =>
    Effect.gen(function* () {
      let calls = 0
      const inactive = yield* makeMemoryQuery(null, () =>
        Effect.sync(() => {
          calls++
          return empty
        })
      )
      yield* waitFor(inactive, (state) => state.matches("inactive"))
      yield* send(inactive, { type: "RETRY" })
      yield* TestClock.adjust("1 hour")
      expect(calls).toBe(0)
      const requests: MemoryQuery[] = []
      const request = { kind: "search" as const, query: "original" }
      const actor = yield* makeMemoryQuery(request, (input) =>
        Effect.suspend(() => {
          requests.push(input)
          return requests.length === 1
            ? Effect.fail("offline")
            : Effect.succeed(empty)
        })
      )
      yield* waitFor(actor, (state) => state.matches("failed"))
      request.query = "mutated"
      yield* TestClock.adjust("1 hour")
      expect(requests).toHaveLength(1)
      expect(actor.getSnapshot().context.error).toBe(
        "Could not search memory. Try again."
      )
      yield* send(actor, { type: "RETRY" })
      yield* waitFor(actor, (state) => state.matches("ready"))
      expect(
        requests.map((value) => value.kind === "search" && value.query)
      ).toEqual(["original", "original"])
    }).pipe(Effect.scoped)
)

it.effect(
  "tree admits one branch read, snapshots its trail and commits navigation only on success",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      const requests: MemoryQuery[] = []
      const actor = yield* makeMemoryQuery(
        { kind: "tree", trail: [], initial: true },
        (input) =>
          Effect.suspend(() => {
            requests.push(input)
            if (requests.length === 1)
              return Effect.succeed({ ...empty, parts: [part] })
            if (requests.length === 2)
              return Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.fail("not ready"))
              )
            return Effect.succeed({
              ...empty,
              trail: input.kind === "tree" ? input.trail : [],
            })
          })
      )
      yield* waitFor(actor, (state) => state.matches("ready"))
      const trail = [{ ...part }]
      yield* send(actor, { type: "OPEN", trail })
      yield* Deferred.await(entered)
      trail[0]!.text = "mutated"
      yield* send(actor, { type: "OPEN", trail: [] })
      yield* send(actor, { type: "RETRY" })
      yield* TestClock.adjust(1)
      yield* Deferred.succeed(release, undefined)
      yield* waitFor(actor, (state) => state.matches("failed"))
      expect(requests).toHaveLength(2)
      expect(actor.getSnapshot().context.data?.trail).toEqual([])
      expect(actor.getSnapshot().context.data?.parts).toEqual([part])
      expect(actor.getSnapshot().context.error).toBe(
        "This part of memory is not ready yet. Try again shortly."
      )
      yield* send(actor, { type: "RETRY" })
      yield* waitFor(actor, (state) => state.matches("ready"))
      expect(actor.getSnapshot().context.data?.trail).toEqual([part])
      yield* send(actor, { type: "OPEN", trail: [] })
      yield* waitFor(
        actor,
        (state) => state.matches("ready") && requests.length === 4
      )
      expect(actor.getSnapshot().context.data?.trail).toEqual([])
    }).pipe(Effect.scoped)
)

it.effect(
  "source absence stays actionable and explicit retry uses the same source",
  () =>
    Effect.gen(function* () {
      const paths: string[] = []
      const actor = yield* makeMemoryQuery(
        { kind: "source", source: 8 },
        memoryQueryRead(async (path) => {
          paths.push(path)
          return {
            children: [],
            original:
              paths.length === 1
                ? null
                : { kind: "user", text: "source", date: "today" },
          }
        })
      )
      yield* waitFor(actor, (state) => state.matches("failed"))
      expect(actor.getSnapshot().context.error).toBe(
        "This source message is unavailable."
      )
      yield* send(actor, { type: "RETRY" })
      yield* waitFor(actor, (state) => state.matches("ready"))
      expect(paths).toEqual(["tree?id=8&n=1", "tree?id=8&n=1"])
      expect(actor.getSnapshot().context.data?.original?.text).toBe("source")
    }).pipe(Effect.scoped)
)

it.effect(
  "scope close aborts and joins the actual held tree read before completing",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make(),
        entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>(),
        aborted = yield* Deferred.make<void>()
      const actor = yield* makeMemoryQuery(
        { kind: "tree", trail: [], initial: true },
        memoryQueryRead((_path, signal) => {
          signal.addEventListener("abort", () =>
            Effect.runSync(Deferred.succeed(aborted, undefined))
          )
          return Effect.runPromise(
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as([part])
            )
          )
        })
      ).pipe(Effect.provideService(Scope.Scope, scope))
      yield* Deferred.await(entered)
      const closing = yield* Scope.close(scope, Exit.void).pipe(
        Effect.forkChild
      )
      yield* Deferred.await(aborted)
      expect(closing.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(closing)
      expect(actor.getSnapshot().context.data).toBeNull()
    }).pipe(Effect.scoped)
)

for (const native of [false, true])
  for (const withDefect of [false, true])
    it.effect(
      `retains complete ${native ? "native" : "Effect"} cleanup Cause ${withDefect ? "with" : "without"} Die`,
      () =>
        Effect.gen(function* () {
          const scope = yield* Scope.make(),
            entered = yield* Deferred.make<void>(),
            release = yield* Deferred.make<void>()
          class Identity extends Context.Service<Identity, string>()(
            "MemoryQueryCleanupIdentity"
          ) {}
          const cause = Cause.fromReasons([
            Cause.makeFailReason("checked cleanup").annotate(
              Context.make(Identity, "checked identity")
            ),
            ...(withDefect
              ? [
                  Cause.makeDieReason("defect cleanup").annotate(
                    Context.make(Identity, "defect identity")
                  ),
                ]
              : []),
            Cause.makeInterruptReason(97234).annotate(
              Context.make(Identity, "native identity")
            ),
          ])
          const failed = Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Effect.failCause(cause))
          )
          yield* makeMemoryQuery(
            { kind: "source", source: 1 },
            native
              ? memoryQueryRead(() =>
                  Effect.runPromiseExit(failed).then((exit) => {
                    if (Exit.isFailure(exit)) throw exit.cause
                    return exit.value
                  })
                )
              : () => failed.pipe(Effect.uninterruptible)
          ).pipe(Effect.provideService(Scope.Scope, scope))
          yield* Deferred.await(entered)
          const closing = yield* Scope.close(scope, Exit.void).pipe(
            Effect.exit,
            Effect.forkChild
          )
          yield* Effect.yieldNow
          expect(closing.pollUnsafe()).toBeUndefined()
          yield* Deferred.succeed(release, undefined)
          const exit = yield* Fiber.join(closing)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            expect(exit.cause.reasons).toContainEqual(
              expect.objectContaining({ _tag: "Interrupt", fiberId: 97234 })
            )
            const interrupt = exit.cause.reasons.find(
              (reason) =>
                reason._tag === "Interrupt" && reason.fiberId === 97234
            )
            expect(interrupt?.annotations.get(Identity.key)).toBe(
              "native identity"
            )
            expect(exit.cause.reasons).toContainEqual(
              expect.objectContaining({
                _tag: "Die",
                defect: expect.objectContaining({
                  _tag: "Fail",
                  error: "checked cleanup",
                  annotations: expect.anything(),
                }),
              })
            )
            const checked = exit.cause.reasons.find(
              (reason) =>
                reason._tag === "Die" &&
                Cause.isReason(reason.defect) &&
                Cause.isFailReason(reason.defect)
            )
            if (
              checked?._tag === "Die" &&
              Cause.isReason(checked.defect) &&
              Cause.isFailReason(checked.defect)
            )
              expect(checked.defect.annotations.get(Identity.key)).toBe(
                "checked identity"
              )
            if (withDefect)
              expect(
                exit.cause.reasons
                  .find(
                    (reason) =>
                      reason._tag === "Die" &&
                      reason.defect === "defect cleanup"
                  )
                  ?.annotations.get(Identity.key)
              ).toBe("defect identity")
          }
        }).pipe(Effect.scoped)
    )

it.effect("malformed tree events cannot dispatch a read", () =>
  Effect.gen(function* () {
    let reads = 0
    const actor = yield* makeMemoryQuery(
      { kind: "tree", trail: [], initial: true },
      () =>
        Effect.sync(() => {
          reads++
          return empty
        })
    )
    yield* waitFor(actor, (state) => state.matches("ready"))
    yield* send(actor, { type: "OPEN", trail: [{ start: "invalid" }] } as never)
    yield* Effect.yieldNow
    expect(reads).toBe(1)
  }).pipe(Effect.scoped)
)
