import { it } from "@effect/vitest"
import { send, waitFor } from "@xstate/effect"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import { expect, test } from "vitest"

import {
  makeMemoryImport,
  readMemoryImport,
  submitMemoryImport,
} from "../src/features/memory/import-owner"

const file = {
  name: "history.jsonl",
  size: 10,
  text: async () => "original body",
}
it.effect(
  "admits one file read, ignores replacement during work and retries the captured body",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      const reads: string[] = [],
        bodies: string[] = []
      const actor = yield* makeMemoryImport({
        read: (input) =>
          Effect.sync(() => {
            reads.push(input.name)
          }).pipe(
            Effect.andThen(Deferred.succeed(entered, undefined)),
            Effect.andThen(Deferred.await(release)),
            Effect.as("original body")
          ),
        submit: (body) =>
          Effect.suspend(() => {
            bodies.push(body)
            return bodies.length === 1
              ? Effect.fail(new Error("unconfirmed"))
              : Effect.succeed({ added: 2 })
          }),
      })
      yield* send(actor, { type: "SELECT", file, id: "first" })
      yield* send(actor, { type: "SUBMIT" })
      yield* send(actor, { type: "SUBMIT" })
      yield* Deferred.await(entered)
      yield* send(actor, {
        type: "SELECT",
        file: { ...file, name: "replacement" },
        id: "second",
      })
      yield* TestClock.adjust(1)
      yield* Deferred.succeed(release, undefined)
      yield* waitFor(actor, (state) => state.matches("unconfirmed"))
      expect(actor.getSnapshot().context.id).toBe("first")
      expect(reads).toEqual([file.name])
      expect(bodies).toEqual(["original body"])
      yield* send(actor, { type: "RETRY" })
      yield* waitFor(actor, (state) => state.matches("done"))
      expect(reads).toEqual([file.name])
      expect(bodies).toEqual(["original body", "original body"])
      yield* send(actor, { type: "SUBMIT" })
      yield* Effect.yieldNow
      expect(bodies).toHaveLength(2)
    }).pipe(Effect.scoped)
)

it.effect(
  "closing a view during a held file read joins it without submitting",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make(),
        entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      let posts = 0
      const actor = yield* makeMemoryImport({
        read: (input) => readMemoryImport(input),
        submit: () =>
          Effect.sync(() => {
            posts++
            return { added: 1 }
          }),
      }).pipe(Effect.provideService(Scope.Scope, scope))
      yield* send(actor, {
        type: "SELECT",
        id: "held",
        file: {
          ...file,
          text: () =>
            Effect.runPromise(
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as("held body")
              )
            ),
        },
      })
      yield* send(actor, { type: "SUBMIT" })
      yield* Deferred.await(entered)
      const closing = yield* Scope.close(scope, Exit.void).pipe(
        Effect.exit,
        Effect.forkChild
      )
      yield* Effect.yieldNow
      expect(closing.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(closing)
      expect(posts).toBe(0)
    }).pipe(Effect.scoped)
)

test("bounds both declared file size and decoded bytes before submission", async () => {
  let read = false
  expect(
    Exit.isFailure(
      await Effect.runPromiseExit(
        readMemoryImport({
          ...file,
          size: 1_000_001,
          text: async () => {
            read = true
            return "large"
          },
        })
      )
    )
  ).toBe(true)
  expect(read).toBe(false)
  expect(
    Exit.isFailure(
      await Effect.runPromiseExit(
        readMemoryImport({ ...file, text: async () => "x".repeat(1_000_001) })
      )
    )
  ).toBe(true)
  expect(
    Exit.isFailure(
      await Effect.runPromiseExit(
        submitMemoryImport(async () => ({ added: -1 }), "body")
      )
    )
  ).toBe(true)
})
