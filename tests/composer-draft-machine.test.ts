import { it } from "@effect/vitest"
import { waitFor } from "@xstate/effect"
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { expect } from "vitest"

import { emptyDraft } from "../src/features/conversation/composer-draft"
import { makeComposerDraft } from "../src/features/conversation/composer-draft-owner"

it.effect(
  "keeps an unreadable record fenced while allowing recoverable in-memory edits",
  () =>
    Effect.gen(function* () {
      const writes: unknown[] = []
      const owner = yield* makeComposerDraft(
        { draft: emptyDraft(), unreadable: true },
        (draft) =>
          Effect.sync(() => {
            writes.push(draft)
          })
      )
      expect(yield* owner.update(() => ({ text: "Keep this in memory" }))).toBe(
        false
      )
      expect(owner.actor.getSnapshot().matches("unreadable")).toBe(true)
      expect(owner.actor.getSnapshot().context.draft.text).toBe(
        "Keep this in memory"
      )
      expect(writes).toEqual([])
    }).pipe(Effect.scoped)
)

it.effect(
  "failed removal remains unsafe even when the new draft is empty",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeComposerDraft(
        { draft: { ...emptyDraft(), text: "Saved text" }, unreadable: false },
        () => Effect.fail("storage unavailable")
      )
      expect(yield* owner.update(() => ({ text: "" }))).toBe(false)
      expect(
        (yield* waitFor(owner.actor, (state) => state.matches("unsaved")))
          .context.draft.text
      ).toBe("")
    }).pipe(Effect.scoped)
)

it.effect(
  "serializes saves and never lets a stale save clear the newest unsaved state",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      const writes: string[] = []
      const owner = yield* makeComposerDraft(
        { draft: emptyDraft(), unreadable: false },
        (draft) =>
          Effect.gen(function* () {
            writes.push(draft.text)
            if (draft.text === "first") {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
            } else return yield* Effect.fail("second write failed")
          })
      )
      const first = yield* owner
        .update(() => ({ text: "first" }))
        .pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const second = yield* owner
        .update(() => ({ text: "second" }))
        .pipe(Effect.forkChild)
      yield* waitFor(owner.actor, (state) => state.context.revision === 2)
      expect(writes).toEqual(["first"])
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(first)).toBe(true)
      expect(yield* Fiber.join(second)).toBe(false)
      expect(
        (yield* waitFor(owner.actor, (state) => state.matches("unsaved")))
          .context.draft.text
      ).toBe("second")
      expect(writes).toEqual(["first", "second"])
    }).pipe(Effect.scoped)
)

it.effect(
  "scope closure joins the current save and settles waiting callers without starting another save",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      const writes: string[] = []
      const owner = yield* makeComposerDraft(
        { draft: emptyDraft(), unreadable: false },
        (draft) =>
          Effect.gen(function* () {
            writes.push(draft.text)
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          }).pipe(Effect.uninterruptible)
      ).pipe(Effect.provideService(Scope.Scope, scope))
      const result = yield* owner
        .update(() => ({ text: "owned" }))
        .pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const closing = yield* Scope.close(scope, Exit.void).pipe(
        Effect.forkChild
      )
      yield* Effect.yieldNow
      expect(closing.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(closing)
      expect(yield* Fiber.join(result)).toBe(false)
      expect(writes).toEqual(["owned"])
    })
)

it.effect(
  "rejects invalid edits rather than leaving a waiting submission stuck",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeComposerDraft(
        { draft: emptyDraft(), unreadable: false },
        () => Effect.void
      )
      expect(yield* owner.update(() => ({ text: "x".repeat(30_001) }))).toBe(
        false
      )
      expect(owner.actor.getSnapshot().status).toBe("error")
    }).pipe(Effect.scoped)
)

it.effect("draft scope closure preserves a late compound write failure", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make(),
      entered = yield* Deferred.make<void>(),
      release = yield* Deferred.make<void>()
    const defect = new Error("storage cleanup defect")
    const compound = Cause.combine(
      Cause.fail("late storage failure"),
      Cause.die(defect)
    )
    const owner = yield* makeComposerDraft(
      { draft: emptyDraft(), unreadable: false },
      () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
          return yield* Effect.failCause(compound)
        }).pipe(Effect.uninterruptible)
    ).pipe(Effect.provideService(Scope.Scope, scope))
    yield* owner.update(() => ({ text: "Retain this" })).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    const closing = yield* Scope.close(scope, Exit.void).pipe(
      Effect.exit,
      Effect.forkChild
    )
    yield* Effect.yieldNow
    expect(closing.pollUnsafe()).toBeUndefined()
    yield* Deferred.succeed(release, undefined)
    const result = yield* Fiber.join(closing)
    expect(
      Exit.isFailure(result) &&
        result.cause.reasons.some(
          (reason) => reason._tag === "Die" && reason.defect === defect
        )
    ).toBe(true)
  })
)
