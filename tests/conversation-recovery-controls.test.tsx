import { it } from "@effect/vitest"
import { createEffectActor, send, waitFor } from "@xstate/effect"
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, test } from "vitest"

import {
  RecoveryControlsView,
  requestRecovery,
} from "../src/features/conversation/recovery-controls"
import { makeRecoveryControls } from "../src/features/conversation/recovery-controls-owner"
import {
  recoveryControlsMachine,
  type RecoveryRequest,
} from "../src/features/conversation/recovery-controls.machine"

const view = {
  operationId: "00000000-0000-4000-8000-000000000001",
  revision: 3,
  unconfirmed: "observe" as const,
  busy: false,
}
const check = {
  type: "SUBMIT" as const,
  action: "check" as const,
  operationId: view.operationId,
  revision: view.revision,
}

it.effect(
  "sends only the original revision once and waits for a newer snapshot after acknowledgement",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const calls: RecoveryRequest[] = []
      const actor = yield* createEffectActor(
        recoveryControlsMachine((request) =>
          Effect.sync(() => calls.push(request)).pipe(
            Effect.andThen(Deferred.succeed(entered, undefined)),
            Effect.andThen(Deferred.await(release))
          )
        ),
        { input: view }
      )
      yield* send(actor, check)
      yield* Deferred.await(entered)
      yield* send(actor, check)
      yield* send(actor, { ...check, action: "stop" })
      yield* Deferred.succeed(release, undefined)
      yield* waitFor(actor, (state) => state.matches("settled"))
      yield* send(actor, check)
      yield* Effect.yieldNow
      expect(calls).toEqual([
        { operationId: view.operationId, revision: 3, action: "check" },
      ])
      yield* send(actor, { type: "VIEW", ...view, revision: 4 })
      yield* waitFor(actor, (state) => state.matches("ready"))
      yield* send(actor, check)
      yield* Effect.yieldNow
      expect(calls).toHaveLength(1)
      yield* send(actor, { ...check, revision: 4 })
      yield* waitFor(actor, (state) => state.matches("settled"))
      expect(calls).toEqual([
        { operationId: view.operationId, revision: 3, action: "check" },
        { operationId: view.operationId, revision: 4, action: "check" },
      ])
    }).pipe(Effect.scoped)
)

it.effect(
  "rejects stale identity, Stop without an uncertain Stop, and owned cleanup",
  () =>
    Effect.gen(function* () {
      const calls: RecoveryRequest[] = []
      const actor = yield* createEffectActor(
        recoveryControlsMachine((request) =>
          Effect.sync(() => {
            calls.push(request)
          })
        ),
        { input: view }
      )
      yield* send(actor, {
        ...check,
        operationId: "00000000-0000-4000-8000-000000000002",
      })
      yield* send(actor, { ...check, action: "stop" })
      yield* send(actor, {
        type: "VIEW",
        ...view,
        unconfirmed: "stop",
        busy: true,
        revision: 4,
      })
      yield* waitFor(actor, (state) => state.context.view.revision === 4)
      yield* send(actor, { ...check, revision: 4, action: "stop" })
      yield* send(actor, { type: "VIEW", ...view, revision: 2 })
      yield* Effect.yieldNow
      expect(calls).toEqual([])
      expect(actor.getSnapshot().context.view).toMatchObject({
        revision: 4,
        busy: true,
      })
      yield* send(actor, {
        type: "VIEW",
        ...view,
        revision: 4,
        unconfirmed: "stop",
      })
      yield* send(actor, { ...check, revision: 4, action: "stop" })
      yield* waitFor(actor, (state) => state.matches("settled"))
      expect(calls).toEqual([
        { operationId: view.operationId, revision: 4, action: "stop" },
      ])
    }).pipe(Effect.scoped)
)

it.effect(
  "retains the complete failure and only retries after another explicit action",
  () =>
    Effect.gen(function* () {
      const defect = new Error("private decoder defect")
      const failure = Cause.fromReasons([
        Cause.makeFailReason("transport unavailable"),
        Cause.makeDieReason(defect),
      ])
      let calls = 0
      const actor = yield* makeRecoveryControls(view, () =>
        Effect.sync(() => {
          calls++
        }).pipe(Effect.andThen(Effect.failCause(failure)))
      )
      yield* send(actor, check)
      const state = yield* waitFor(actor, (state) => state.matches("settled"))
      const outcome = state.context.outcome
      expect(outcome && Exit.isFailure(outcome)).toBe(true)
      if (!outcome || !Exit.isFailure(outcome))
        throw new Error("Missing failure")
      expect(outcome.cause.reasons).toMatchObject([
        { _tag: "Fail", error: "transport unavailable" },
        { _tag: "Die", defect },
      ])
      yield* Effect.yieldNow
      expect(calls).toBe(1)
      yield* send(actor, check)
      yield* waitFor(actor, (state) => state.matches("settled") && calls === 2)
      expect(calls).toBe(2)
    }).pipe(Effect.scoped)
)

it.effect(
  "joins held request cleanup when the component scope is disposed",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const cleaning = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      const actor = yield* createEffectActor(
        recoveryControlsMachine(() =>
          Effect.acquireRelease(Deferred.succeed(entered, undefined), () =>
            Deferred.succeed(cleaning, undefined).pipe(
              Effect.andThen(Deferred.await(release))
            )
          ).pipe(Effect.andThen(Effect.never))
        ),
        { input: view }
      ).pipe(Effect.provideService(Scope.Scope, scope))
      yield* send(actor, check)
      yield* Deferred.await(entered)
      const closed = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild)
      yield* Deferred.await(cleaning)
      expect(closed.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(closed)
      expect(actor.getSnapshot().status).toBe("stopped")
    })
)

test("shows read-only checking and explicit Stop recovery without ordinary retry or private ownership", () => {
  const render = (unconfirmed: "handoff" | "observe" | "stop", busy = false) =>
    renderToStaticMarkup(
      <RecoveryControlsView
        view={{ ...view, unconfirmed, busy }}
        pending={null}
        awaitingSnapshot={false}
        failed={false}
        submit={() => {}}
      />
    )
  for (const phase of ["handoff", "observe", "stop"] as const) {
    const html = render(phase)
    expect(html).toContain("Check reply")
    expect(html.includes("Try Stop again")).toBe(phase === "stop")
    expect(html).not.toContain("Retry message")
    expect(html).not.toContain(view.operationId)
    expect(html).not.toContain('disabled=""')
  }
  expect(render("stop", true)).toContain("finish cleanup")
  expect((render("stop", true).match(/\sdisabled=""/g) ?? []).length).toBe(2)
  const failed = renderToStaticMarkup(
    <RecoveryControlsView
      view={view}
      pending={null}
      awaitingSnapshot={false}
      failed
      submit={() => {}}
    />
  )
  expect(failed).toContain('role="alert"')
  expect(failed).not.toContain("private decoder defect")
})

test("posts recovery against the original identity and refreshes after success or conflict", async () => {
  const calls: { path: string; body: unknown; signal: AbortSignal }[] = []
  let refreshes = 0
  for (const action of ["check", "stop"] as const) {
    await Effect.runPromise(
      requestRecovery(
        async (path, body, signal) => {
          calls.push({ path, body, signal })
          return { ok: true }
        },
        () => {
          refreshes++
        },
        { action, operationId: view.operationId, revision: view.revision }
      )
    )
  }
  expect(calls.map(({ path, body }) => ({ path, body }))).toEqual([
    {
      path: "recovery/check",
      body: { operationId: view.operationId, revision: 3 },
    },
    {
      path: "recovery/stop",
      body: { operationId: view.operationId, revision: 3 },
    },
  ])
  expect(calls.every(({ signal }) => signal instanceof AbortSignal)).toBe(true)
  const conflict = new Error("revision changed")
  const exit = await Effect.runPromiseExit(
    requestRecovery(
      async () => {
        throw conflict
      },
      () => {
        refreshes++
      },
      { action: "stop", operationId: view.operationId, revision: 3 }
    )
  )
  expect(Exit.isFailure(exit) && exit.cause.reasons).toMatchObject([
    { _tag: "Fail", error: conflict },
  ])
  expect(refreshes).toBe(3)
})

it.effect(
  "retains late cleanup failure after the recovery component closes",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const cleaning = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      const defect = new Error("late recovery cleanup")
      const actor = yield* makeRecoveryControls(view, () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Deferred.succeed(cleaning, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(Effect.die(defect))
            )
          )
        )
      ).pipe(Effect.provideService(Scope.Scope, scope))
      yield* send(actor, check)
      yield* Deferred.await(entered)
      const closing = yield* Scope.close(scope, Exit.void).pipe(
        Effect.exit,
        Effect.forkChild
      )
      yield* Deferred.await(cleaning)
      expect(closing.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      const exit = yield* Fiber.join(closing)
      expect(Exit.isFailure(exit) && exit.cause.reasons).toContainEqual(
        expect.objectContaining({ _tag: "Die", defect })
      )
    })
)
