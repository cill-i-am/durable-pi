import { it } from "@effect/vitest"
import { createEffectActor, send, waitFor } from "@xstate/effect"
import { Deferred, Effect, Exit, Scope } from "effect"
import { expect } from "vitest"

import { questionMachine } from "../src/features/rich-results/question.machine"

it.effect(
  "appends one immutable answer per revision and reopens after editing",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const answers: string[] = []
      const actor = yield* createEffectActor(
        questionMachine((answer) =>
          Effect.sync(() => {
            answers.push(answer.text)
          }).pipe(
            Effect.andThen(Deferred.succeed(entered, undefined)),
            Effect.andThen(Deferred.await(finish))
          )
        ),
        { input: { revision: 0, enabled: true } }
      )
      yield* send(actor, { type: "ADD", revision: 0, text: "Original" })
      yield* Deferred.await(entered)
      yield* send(actor, { type: "ADD", revision: 0, text: "Duplicate" })
      yield* send(actor, { type: "VIEW", revision: 1, enabled: true })
      yield* send(actor, { type: "ADD", revision: 1, text: "Too early" })
      yield* send(actor, { type: "VIEW", revision: 1, enabled: false })
      yield* waitFor(actor, (state) => state.context.view.enabled === false)
      yield* Deferred.succeed(finish, undefined)
      yield* waitFor(actor, (state) => state.matches("editing"))
      expect(answers).toEqual(["Original"])
      yield* send(actor, { type: "VIEW", revision: 1, enabled: true })
      yield* send(actor, { type: "ADD", revision: 0, text: "Stale" })
      yield* send(actor, { type: "ADD", revision: 1, text: "Edited" })
      yield* waitFor(actor, (state) => state.matches("added"))
      yield* send(actor, { type: "ADD", revision: 1, text: "Duplicate" })
      yield* Effect.yieldNow
      expect(answers).toEqual(["Original", "Edited"])
    }).pipe(Effect.scoped)
)

it.effect(
  "rejects disabled, blank and malformed admission without invoking the draft callback",
  () =>
    Effect.gen(function* () {
      let calls = 0
      const actor = yield* createEffectActor(
        questionMachine(() =>
          Effect.sync(() => {
            calls++
          })
        ),
        { input: { revision: 0, enabled: false } }
      )
      yield* send(actor, { type: "ADD", revision: 0, text: "Disabled" })
      yield* send(actor, { type: "VIEW", revision: 0, enabled: true })
      yield* send(actor, { type: "ADD", revision: 0, text: " " })
      yield* send(actor, { type: "ADD", revision: -1, text: "Malformed" })
      yield* send(actor, { type: "ADD", revision: 0, text: null } as never)
      yield* Effect.yieldNow
      expect(calls).toBe(0)
      expect(actor.getSnapshot().matches("editing")).toBe(true)
    }).pipe(Effect.scoped)
)

it.effect(
  "a failed append preserves its attempt and permits only explicit retry",
  () =>
    Effect.gen(function* () {
      let calls = 0
      const actor = yield* createEffectActor(
        questionMachine(() =>
          Effect.suspend(() => {
            calls++
            return calls === 1 ? Effect.fail("draft unavailable") : Effect.void
          })
        ),
        { input: { revision: 0, enabled: true } }
      )
      yield* send(actor, { type: "ADD", revision: 0, text: "Retain me" })
      yield* waitFor(
        actor,
        (state) =>
          state.matches("editing") && state.context.failure !== undefined
      )
      expect(actor.getSnapshot().context.answer?.text).toBe("Retain me")
      expect(calls).toBe(1)
      yield* send(actor, { type: "ADD", revision: 0, text: "Retain me" })
      yield* waitFor(actor, (state) => state.matches("added"))
      expect(calls).toBe(2)
    }).pipe(Effect.scoped)
)

it.effect("unmount interrupts a pending append before its callback runs", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let calls = 0
    const scope = yield* Scope.make()
    const actor = yield* createEffectActor(
      questionMachine(() =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(
            Effect.sync(() => {
              calls++
            })
          )
        )
      ),
      { input: { revision: 0, enabled: true } }
    ).pipe(Scope.provide(scope))
    yield* send(actor, { type: "ADD", revision: 0, text: "Cancelled" })
    yield* Deferred.await(entered)
    yield* Scope.close(scope, Exit.void)
    yield* Deferred.succeed(release, undefined)
    expect(calls).toBe(0)
  })
)
