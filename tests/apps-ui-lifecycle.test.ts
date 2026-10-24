import { it } from "@effect/vitest"
import { createEffectActor, send, waitFor } from "@xstate/effect"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"

import type { AppDetail, AppDocument } from "../src/apps/contracts"
import { appFormMachine } from "../src/features/apps/app-form.machine"
import { appListMachine } from "../src/features/apps/app-list.machine"
import { appCommand, makeAppOwner } from "../src/features/apps/app-owner"
import { makeFrameOwner } from "../src/features/apps/web-canvas-owner"
import { nativeOperation } from "../src/shared/interop"

const id = "11111111-1111-4111-8111-111111111111"
const app: AppDocument = {
  id,
  version: 1,
  revision: 1,
  publishedVersion: 1,
  archived: false,
  createdAt: "2026-10-23",
  state: { checks: {}, forms: {} },
  definition: {
    title: "App",
    description: "",
    blocks: [{ id: "text", type: "text", text: "Hello" }],
  },
}
const detail: AppDetail = { app, versions: [app], events: [] }
const attempt = {
  path: "apps/interact",
  input: { operationId: id, id, expectedRevision: 1, value: "original" },
}
const frame = (channel = "first") => ({
  channel,
  html: "<p>preview</p>",
  preview: { id, version: 1, revision: 1, html: "", css: "" },
})
const action = {
  type: "web" as const,
  blockId: "web",
  name: "save",
  values: {},
}

it.effect(
  "uncertain app retry preserves original identity and payload, and refresh never submits",
  () =>
    Effect.gen(function* () {
      const calls: unknown[] = []
      const actor = yield* makeAppOwner(
        { agentId: "one", id, visible: false },
        {
          read: Effect.succeed(detail),
          mutate: (request) =>
            Effect.suspend(() => {
              calls.push(request)
              return calls.length === 1
                ? Effect.fail(new Error("offline"))
                : Effect.succeed(app)
            }),
          cancel: () => Effect.succeed({ applied: false }),
        }
      )
      expect(yield* appCommand(actor, { type: "mutate", attempt })).toBe(false)
      yield* send(actor, { type: "REFRESH" })
      yield* waitFor(
        actor,
        (state) => state.matches("waiting") || state.matches("hidden")
      )
      expect(calls).toHaveLength(1)
      expect(
        yield* appCommand(actor, {
          type: "mutate",
          attempt: {
            path: "apps/archive",
            input: { operationId: "different", value: "changed" },
          },
        })
      ).toBe(true)
      expect(calls).toEqual([attempt, attempt])
      expect(actor.getSnapshot().context.attempt).toBeNull()
    }).pipe(Effect.scoped)
)

it.effect(
  "a held app mutation rejects a second command and joins cleanup without an old refresh",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        aborted = yield* Deferred.make<void>(),
        scope = yield* Scope.make()
      let release!: () => void,
        reads = 0
      const actor = yield* makeAppOwner(
        { agentId: "one", id, visible: false },
        {
          read: Effect.sync(() => {
            reads++
            return detail
          }),
          mutate: () =>
            nativeOperation(
              (signal) =>
                new Promise<AppDocument>((resolve) => {
                  release = () => resolve(app)
                  signal.addEventListener("abort", () =>
                    Effect.runSync(Deferred.succeed(aborted, undefined))
                  )
                  Effect.runSync(Deferred.succeed(entered, undefined))
                }),
              (cause) => cause
            ),
          cancel: () => Effect.succeed({ applied: false }),
        }
      ).pipe(Scope.provide(scope))
      const pending = yield* appCommand(actor, {
        type: "mutate",
        attempt,
      }).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      expect(yield* appCommand(actor, { type: "cancel" })).toBe(false)
      const closing = yield* Scope.close(scope, Exit.void).pipe(
        Effect.forkChild
      )
      yield* Deferred.await(aborted)
      expect(closing.pollUnsafe()).toBeUndefined()
      release()
      yield* Fiber.join(closing)
      expect(yield* Fiber.join(pending)).toBe(false)
      expect(reads).toBe(0)
    })
)

it.effect(
  "already-applied cancellation retains its operation until a confirmed reload",
  () =>
    Effect.gen(function* () {
      let reads = 0
      const cancelled: unknown[] = []
      const actor = yield* makeAppOwner(
        { agentId: "one", id, visible: false },
        {
          read: Effect.suspend(() =>
            ++reads === 2
              ? Effect.fail(new Error("reload unavailable"))
              : Effect.succeed(detail)
          ),
          mutate: () => Effect.fail(new Error("unconfirmed")),
          cancel: (request) =>
            Effect.sync(() => {
              cancelled.push(request.input.operationId)
              return { applied: true }
            }),
        }
      )
      expect(yield* appCommand(actor, { type: "mutate", attempt })).toBe(false)
      expect(yield* appCommand(actor, { type: "cancel" })).toBe(false)
      expect(actor.getSnapshot().context.attempt).toEqual(attempt)
      expect(yield* appCommand(actor, { type: "cancel" })).toBe(true)
      expect(cancelled).toEqual([id, id])
      expect(actor.getSnapshot().context.attempt).toBeNull()
    }).pipe(Effect.scoped)
)

it.effect("stopping a held frame action joins it and cannot render again", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>(),
      aborted = yield* Deferred.make<void>(),
      scope = yield* Scope.make()
    let release!: () => void,
      renders = 0,
      removed = false
    const actor = yield* makeFrameOwner(
      { revision: 1, disabled: false },
      {
        render: Effect.sync(() => {
          renders++
          return frame()
        }),
        bridge: Effect.never.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              removed = true
            })
          )
        ),
        action: () =>
          nativeOperation(
            (signal) =>
              new Promise<boolean>((resolve) => {
                release = () => resolve(true)
                signal.addEventListener("abort", () =>
                  Effect.runSync(Deferred.succeed(aborted, undefined))
                )
                Effect.runSync(Deferred.succeed(entered, undefined))
              }),
            (cause) => cause
          ),
      }
    ).pipe(Scope.provide(scope))
    yield* waitFor(actor, (state) => state.matches({ owned: "ready" }))
    yield* send(actor, { type: "ACTION", channel: "first", action })
    yield* Deferred.await(entered)
    const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild)
    yield* Deferred.await(aborted)
    expect(closing.pollUnsafe()).toBeUndefined()
    release()
    yield* Fiber.join(closing)
    expect(renders).toBe(1)
    expect(removed).toBe(true)
  })
)

it.effect(
  "frame channels, current revision and disabled state fence action admission",
  () =>
    Effect.gen(function* () {
      let calls = 0,
        renders = 0
      const actor = yield* makeFrameOwner(
        { revision: 1, disabled: false },
        {
          render: Effect.sync(() =>
            frame(++renders === 1 ? "first" : "second")
          ),
          bridge: Effect.never,
          action: () =>
            Effect.sync(() => {
              calls++
              return false
            }),
        }
      )
      yield* waitFor(actor, (state) => state.matches({ owned: "ready" }))
      yield* send(actor, { type: "RELOAD" })
      yield* waitFor(
        actor,
        (state) => state.context.source?.channel === "second"
      )
      yield* send(actor, { type: "ACTION", channel: "first", action })
      yield* send(actor, { type: "SYNC", revision: 2, disabled: false })
      yield* send(actor, { type: "ACTION", channel: "second", action })
      yield* send(actor, { type: "SYNC", revision: 1, disabled: true })
      yield* send(actor, { type: "ACTION", channel: "second", action })
      yield* send(actor, { type: "SYNC", revision: 1, disabled: false })
      yield* waitFor(actor, (state) => !state.context.disabled)
      expect(calls).toBe(0)
      yield* send(actor, { type: "ACTION", channel: "second", action })
      yield* waitFor(
        actor,
        (state) => state.matches({ owned: "ready" }) && calls === 1
      )
      expect(calls).toBe(1)
    }).pipe(Effect.scoped)
)

it.effect("form completion cannot erase newer edits including edit ABA", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>(),
      release = yield* Deferred.make<void>()
    const actor = yield* createEffectActor(
      appFormMachine(() =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(true)
        )
      ),
      { input: { saved: {}, revision: 1, disabled: false } }
    )
    yield* send(actor, { type: "EDIT", field: "name", value: "A" })
    yield* send(actor, { type: "SUBMIT" })
    yield* Deferred.await(entered)
    yield* send(actor, { type: "EDIT", field: "name", value: "B" })
    yield* send(actor, { type: "EDIT", field: "name", value: "A" })
    yield* waitFor(actor, (state) => state.context.editRevision === 3)
    yield* Deferred.succeed(release, undefined)
    yield* waitFor(actor, (state) => state.matches("editing"))
    expect(actor.getSnapshot().context.draft?.values).toEqual({ name: "A" })
    expect(actor.getSnapshot().context.submitted).toBe(false)
  }).pipe(Effect.scoped)
)

it.effect("app list visibility suspends polls until visible again", () =>
  Effect.gen(function* () {
    let calls = 0
    const actor = yield* createEffectActor(
      appListMachine(
        Effect.sync(() => {
          calls++
          return { apps: [app] }
        })
      ),
      { input: { agentId: "one", visible: false } }
    )
    yield* TestClock.adjust("20 seconds")
    expect(calls).toBe(0)
    yield* send(actor, { type: "VISIBILITY", visible: true })
    yield* waitFor(actor, (state) => state.matches("waiting"))
    expect(calls).toBe(1)
    yield* send(actor, { type: "VISIBILITY", visible: false })
    yield* waitFor(actor, (state) => state.matches("hidden"))
    yield* TestClock.adjust("20 seconds")
    expect(calls).toBe(1)
  }).pipe(Effect.scoped)
)

it.effect(
  "joined app cleanup retains the full late native compound Cause",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        aborted = yield* Deferred.make<void>(),
        scope = yield* Scope.make()
      let reject!: (cause: unknown) => void
      const defect = new Error("late native app cleanup")
      const actor = yield* makeAppOwner(
        { agentId: "one", id, visible: false },
        {
          read: Effect.succeed(detail),
          mutate: () =>
            nativeOperation(
              (signal) =>
                new Promise((_, fail) => {
                  reject = fail
                  signal.addEventListener("abort", () =>
                    Effect.runSync(Deferred.succeed(aborted, undefined))
                  )
                  Effect.runSync(Deferred.succeed(entered, undefined))
                }),
              (cause) => cause
            ),
          cancel: () => Effect.succeed({ applied: false }),
        }
      ).pipe(Scope.provide(scope))
      const pending = yield* appCommand(actor, {
        type: "mutate",
        attempt,
      }).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const closing = yield* Effect.exit(Scope.close(scope, Exit.void)).pipe(
        Effect.forkChild
      )
      yield* Deferred.await(aborted)
      reject(
        Cause.fromReasons([
          ...Cause.fail("typed").reasons,
          ...Cause.die(defect).reasons,
          ...Cause.interrupt(4123).reasons,
        ])
      )
      const result = yield* Fiber.join(closing)
      yield* Fiber.join(pending)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        expect(result.cause.reasons).toContainEqual(
          expect.objectContaining({ _tag: "Die", defect })
        )
        expect(result.cause.reasons).toContainEqual(
          expect.objectContaining({ _tag: "Interrupt", fiberId: 4123 })
        )
        expect(result.cause.reasons).toContainEqual(
          expect.objectContaining({
            _tag: "Die",
            defect: expect.objectContaining({ _tag: "Fail", error: "typed" }),
          })
        )
      }
    })
)

it.effect(
  "joins and retains native Fail plus annotated Interrupt even without an original defect",
  () =>
    Effect.gen(function* () {
      class Marker extends Context.Service<Marker, string>()(
        "AppNativeMarker"
      ) {}
      const entered = yield* Deferred.make<void>(),
        aborted = yield* Deferred.make<void>(),
        scope = yield* Scope.make()
      let reject!: (cause: unknown) => void
      yield* makeAppOwner(
        { agentId: "one", id, visible: true },
        {
          read: nativeOperation(
            (signal) =>
              new Promise<AppDetail>((_, fail) => {
                reject = fail
                signal.addEventListener("abort", () =>
                  Effect.runSync(Deferred.succeed(aborted, undefined))
                )
                Effect.runSync(Deferred.succeed(entered, undefined))
              }),
            (cause) => cause
          ),
          mutate: () => Effect.succeed(app),
          cancel: () => Effect.succeed({ applied: false }),
        }
      ).pipe(Scope.provide(scope))
      yield* Deferred.await(entered)
      const closing = yield* Effect.exit(Scope.close(scope, Exit.void)).pipe(
        Effect.forkChild
      )
      yield* Deferred.await(aborted)
      expect(closing.pollUnsafe()).toBeUndefined()
      reject(
        Cause.fromReasons([
          Cause.makeFailReason("native failed"),
          Cause.makeInterruptReason(81234).annotate(
            Context.make(Marker, "app")
          ),
        ])
      )
      const result = yield* Fiber.join(closing)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        expect(
          result.cause.reasons.some(
            (reason) =>
              reason._tag === "Interrupt" &&
              reason.fiberId === 81234 &&
              reason.annotations.get(Marker.key) === "app"
          )
        ).toBe(true)
        expect(result.cause.reasons).toContainEqual(
          expect.objectContaining({
            _tag: "Die",
            defect: expect.objectContaining({
              _tag: "Fail",
              error: "native failed",
            }),
          })
        )
      }
    })
)
