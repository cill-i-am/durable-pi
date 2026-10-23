import { it } from "@effect/vitest"
import { createEffectActor, send, waitFor } from "@xstate/effect"
import { Deferred, Effect, Exit, Scope } from "effect"
import { createElement } from "react"
import { expect } from "vitest"

import {
  highlightedCodeMachine,
  type LoadedHighlighter,
} from "../src/hooks/highlighted-code.machine"

const language = (name: string): LoadedHighlighter => ({
  highlight: () => ({
    lines: [[createElement("span", null, name)]],
    state: undefined,
  }),
})

it.effect(
  "publishes only the latest language even when prior loading completes late",
  () =>
    Effect.gen(function* () {
      let completeA!: (value: LoadedHighlighter) => void
      const a = new Promise<LoadedHighlighter>((resolve) => {
        completeA = resolve
      })
      const started = yield* Deferred.make<void>()
      const b = language("B")
      const actor = yield* createEffectActor(
        highlightedCodeMachine((name) =>
          name === "A"
            ? Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.promise(() => a))
              )
            : Effect.succeed(b)
        ),
        { input: { language: "A" } }
      )
      yield* Deferred.await(started)
      yield* send(actor, { type: "LANGUAGE", language: "B" })
      yield* waitFor(actor, (state) => state.matches("ready"))
      completeA(language("A"))
      yield* Effect.yieldNow
      expect(actor.getSnapshot().context.highlighter).toBe(b)
      expect(actor.getSnapshot().context.language).toBe("B")
    }).pipe(Effect.scoped)
)

it.effect(
  "cancels observation on unmount without disposing the shared core",
  () =>
    Effect.gen(function* () {
      const pending = yield* Deferred.make<LoadedHighlighter>()
      const started = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      const actor = yield* createEffectActor(
        highlightedCodeMachine(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(pending))
          )
        ),
        { input: { language: "typescript" } }
      ).pipe(Scope.provide(scope))
      yield* Deferred.await(started)
      yield* Scope.close(scope, Exit.void)
      yield* Deferred.succeed(pending, language("late"))
      expect(actor.getSnapshot().status).toBe("stopped")
      expect(actor.getSnapshot().context.highlighter).toBeNull()
    })
)

it.effect(
  "retains plaintext on unsupported or failed loading and only loads after a language change",
  () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const actor = yield* createEffectActor(
        highlightedCodeMachine((name) =>
          Effect.sync(() => {
            calls.push(name)
          }).pipe(
            Effect.andThen(
              name === "broken"
                ? Effect.fail("unavailable")
                : Effect.succeed(null)
            )
          )
        ),
        { input: { language: "unknown" } }
      )
      yield* waitFor(actor, (state) => state.matches("unsupported"))
      yield* send(actor, { type: "LANGUAGE", language: "broken" })
      yield* waitFor(actor, (state) => state.matches("failed"))
      yield* send(actor, { type: "LANGUAGE", language: "broken" })
      yield* send(actor, { type: "LANGUAGE", language: null } as never)
      yield* Effect.yieldNow
      expect(calls).toEqual(["unknown", "broken"])
      expect(actor.getSnapshot().context.highlighter).toBeNull()
      expect(actor.getSnapshot().matches("failed")).toBe(true)
    }).pipe(Effect.scoped)
)
