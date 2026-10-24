import { it } from "@effect/vitest"
import { createEffectActor, send, waitFor } from "@xstate/effect"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import { expect, vi } from "vitest"

import type { CodeRun } from "../src/execution/contracts"
import {
  executionRequests,
  makeExecutionOwner,
} from "../src/features/execution/execution-owner"
import {
  executionMachine,
  type ExecutionCommand,
  type ExecutionLoaded,
  type ExecutionWork,
} from "../src/features/execution/execution.machine"
import { nativeOperation } from "../src/shared/interop"

const view = { agentId: "one", selected: null, visible: true }
const start = {
  type: "START" as const,
  id: "original",
  code: "return input",
  data: "1",
}
const result: CodeRun = {
  id: "original",
  label: "run",
  status: "succeeded",
  createdAt: 1,
  finishedAt: 2,
  input: { code: start.code, data: start.data },
  output: { result: "1", logs: "", error: null },
}
const defaults: ExecutionWork = {
  read: () => Effect.succeed({ runs: [], detail: null }),
  command: () => Effect.succeed(result),
  select: () => Effect.void,
}

it.effect(
  "late command cannot select a result after the selected view changes",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      const selected: string[] = []
      const actor = yield* createEffectActor(
        executionMachine({
          ...defaults,
          command: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(result)
            ),
          select: ({ id }) =>
            Effect.sync(() => {
              selected.push(id)
            }),
        }),
        { input: view }
      )
      yield* send(actor, start)
      yield* Deferred.await(entered)
      yield* send(actor, { type: "VIEW", selected: "other" })
      yield* waitFor(actor, (state) => state.context.view.selected === "other")
      yield* Deferred.succeed(release, undefined)
      yield* waitFor(actor, (state) => state.matches({ command: "ready" }))
      expect(selected).toEqual([])
      expect(actor.getSnapshot().context.attempt).toBeNull()
      expect(actor.getSnapshot().context.detail?.id).not.toBe("original")
    }).pipe(Effect.scoped)
)

it.effect(
  "uncertain explicit retry retains the exact immutable run and does not repeat from polls",
  () =>
    Effect.gen(function* () {
      const calls: ExecutionCommand[] = []
      const actor = yield* createEffectActor(
        executionMachine({
          ...defaults,
          command: (input) =>
            Effect.suspend(() => {
              calls.push(input)
              return calls.length === 1
                ? Effect.fail(new Error("response lost"))
                : Effect.succeed(result)
            }),
        }),
        { input: view }
      )
      yield* send(actor, start)
      yield* waitFor(actor, (state) => state.context.error === "response lost")
      yield* send(actor, { type: "REFRESH" })
      yield* TestClock.adjust("10 seconds")
      expect(calls).toHaveLength(1)
      expect(actor.getSnapshot().context.attempt).toEqual({
        id: "original",
        code: start.code,
        data: start.data,
      })
      yield* send(actor, {
        ...start,
        id: "replacement",
        code: "different",
        data: "[]",
      })
      yield* waitFor(
        actor,
        (state) =>
          state.matches({ command: "ready" }) && state.context.attempt === null
      )
      expect(calls).toEqual([
        {
          kind: "run",
          input: { id: "original", code: start.code, data: start.data },
        },
        {
          kind: "run",
          input: { id: "original", code: start.code, data: start.data },
        },
      ])
    }).pipe(Effect.scoped)
)

it.effect(
  "one command owns admission while refresh and duplicate clicks cannot replace it",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      const calls: ExecutionCommand[] = []
      const actor = yield* createEffectActor(
        executionMachine({
          ...defaults,
          command: (input) =>
            Effect.sync(() => {
              calls.push(input)
            }).pipe(
              Effect.andThen(Deferred.succeed(entered, undefined)),
              Effect.andThen(Deferred.await(release)),
              Effect.as(result)
            ),
        }),
        { input: view }
      )
      yield* send(actor, start)
      yield* Deferred.await(entered)
      yield* send(actor, { type: "REFRESH" })
      yield* send(actor, { ...start, id: "second" })
      yield* send(actor, { type: "CANCEL", id: "original" })
      yield* Effect.yieldNow
      expect(calls).toHaveLength(1)
      expect(
        actor
          .getSnapshot()
          .matches({ resource: "paused", command: "requesting" })
      ).toBe(true)
      yield* Deferred.succeed(release, undefined)
      yield* waitFor(actor, (state) => state.matches({ command: "ready" }))
    }).pipe(Effect.scoped)
)

it.effect(
  "cancel resolves the saved attempt only with its backend identity and status",
  () =>
    Effect.gen(function* () {
      const calls: ExecutionCommand[] = []
      const actor = yield* createEffectActor(
        executionMachine({
          ...defaults,
          command: (input) =>
            Effect.suspend(() => {
              calls.push(input)
              return input.kind === "run"
                ? Effect.fail(new Error("lost response"))
                : Effect.succeed({ ...result, status: "cancelled" })
            }),
        }),
        { input: view }
      )
      yield* send(actor, start)
      yield* waitFor(actor, (state) => state.context.error === "lost response")
      yield* send(actor, { type: "CANCEL", id: "original" })
      yield* waitFor(
        actor,
        (state) =>
          state.matches({ command: "ready" }) && state.context.attempt === null
      )
      expect(calls[1]).toEqual({ kind: "cancel", id: "original" })
    }).pipe(Effect.scoped)
)

it.effect(
  "hidden observers stop polling and refresh results from old selections stay fenced",
  () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>(),
        entered = yield* Deferred.make<void>()
      const reads: Array<string | null> = []
      const actor = yield* createEffectActor(
        executionMachine({
          ...defaults,
          read: (input) =>
            Effect.suspend((): Effect.Effect<ExecutionLoaded> => {
              reads.push(input.selected)
              return input.selected === "old"
                ? Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(gate)),
                    Effect.as({
                      runs: [result],
                      detail: { ...result, id: "old" },
                    })
                  )
                : Effect.succeed({ runs: [], detail: null })
            }),
        }),
        { input: { ...view, selected: "old" } }
      )
      yield* Deferred.await(entered)
      yield* send(actor, { type: "VIEW", selected: "new" })
      yield* waitFor(actor, (state) => state.matches({ resource: "waiting" }))
      yield* Deferred.succeed(gate, undefined)
      yield* send(actor, { type: "VISIBILITY", visible: false })
      yield* waitFor(actor, (state) => state.matches({ resource: "hidden" }))
      const count = reads.length
      yield* TestClock.adjust("30 seconds")
      expect(reads).toHaveLength(count)
      expect(actor.getSnapshot().context.detail).toBeNull()
    }).pipe(Effect.scoped)
)

it.effect("malformed events and invalid code do not invoke the command", () =>
  Effect.gen(function* () {
    let calls = 0
    const actor = yield* createEffectActor(
      executionMachine({
        ...defaults,
        command: () =>
          Effect.sync(() => {
            calls++
            return result
          }),
      }),
      { input: view }
    )
    yield* send(actor, { ...start, data: "invalid" })
    yield* waitFor(actor, (state) =>
      state.context.error.startsWith("Use valid")
    )
    yield* send(actor, { type: "CANCEL", id: 12 } as never)
    yield* Effect.yieldNow
    expect(calls).toBe(0)
    expect(actor.getSnapshot().context.attempt).toBeNull()
  }).pipe(Effect.scoped)
)

it.effect(
  "owner interruption signals and joins the real held request and preserves late cleanup defects",
  () =>
    Effect.gen(function* () {
      let release!: () => void
      let signal: AbortSignal | undefined
      const scope = yield* Scope.make()
      const defect = new Error("native cleanup failed")
      class NativeRequest extends Context.Service<NativeRequest, string>()(
        "ExecutionCleanupRequest"
      ) {}
      const annotations = Context.make(NativeRequest, "execution-native")
      const failure = Cause.fromReasons([
        Cause.makeFailReason("transport"),
        Cause.makeDieReason(defect).annotate(annotations),
        Cause.makeInterruptReason(85235).annotate(annotations),
      ])
      const actor = yield* makeExecutionOwner(view, {
        ...defaults,
        command: () =>
          nativeOperation(
            (value) => {
              signal = value
              return new Promise<CodeRun>((_resolve, reject) => {
                release = () => reject(failure)
              })
            },
            (error) => error
          ),
      }).pipe(Scope.provide(scope))
      yield* send(actor, start)
      yield* waitFor(actor, (state) => state.matches({ command: "requesting" }))
      while (!signal) yield* Effect.yieldNow
      let closed = false
      const closing = yield* Scope.close(scope, Exit.void).pipe(
        Effect.onExit(() =>
          Effect.sync(() => {
            closed = true
          })
        ),
        Effect.forkChild
      )
      while (!signal.aborted) yield* Effect.yieldNow
      expect(closed).toBe(false)
      release()
      const exit = yield* Fiber.await(closing)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("native cleanup failed")
        expect(Cause.pretty(exit.cause)).toContain("transport")
        expect(
          exit.cause.reasons.some(
            (reason) =>
              reason._tag === "Die" &&
              reason.defect === defect &&
              reason.annotations.get(NativeRequest.key) === "execution-native"
          )
        ).toBe(true)
        expect(
          exit.cause.reasons.some(
            (reason) =>
              reason._tag === "Interrupt" &&
              reason.fiberId === 85235 &&
              reason.annotations.get(NativeRequest.key) === "execution-native"
          )
        ).toBe(true)
      }
    }).pipe(Effect.scoped)
)

it.effect(
  "the HTTP boundary rejects another run identity and retains the immutable request",
  () =>
    Effect.gen(function* () {
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(Response.json({ ...result, id: "foreign" }))
      yield* Effect.addFinalizer(() => Effect.sync(() => fetch.mockRestore()))
      const actor = yield* createEffectActor(
        executionMachine({
          ...defaults,
          command: executionRequests("one").command,
        }),
        { input: view }
      )
      yield* send(actor, start)
      yield* waitFor(actor, (state) => state.context.failure !== undefined)
      expect(actor.getSnapshot().context.attempt?.id).toBe("original")
      expect(Cause.isCause(actor.getSnapshot().context.failure)).toBe(true)
      expect(actor.getSnapshot().context.runs).toEqual([])
      expect(fetch).toHaveBeenCalledTimes(1)
    }).pipe(Effect.scoped)
)

it.effect(
  "successful current command selects its exact result once and an active backend run blocks new admission",
  () =>
    Effect.gen(function* () {
      const selected = yield* Deferred.make<string>()
      let calls = 0
      const active = { ...result, status: "running" as const, finishedAt: null }
      const actor = yield* createEffectActor(
        executionMachine({
          ...defaults,
          read: () =>
            Effect.succeed({ runs: calls ? [active] : [], detail: null }),
          command: () =>
            Effect.sync(() => {
              calls++
              return active
            }),
          select: ({ id }) =>
            Deferred.succeed(selected, id).pipe(Effect.asVoid),
        }),
        { input: view }
      )
      yield* send(actor, start)
      expect(yield* Deferred.await(selected)).toBe("original")
      yield* waitFor(
        actor,
        (state) =>
          state.matches({ resource: "waiting" }) &&
          state.context.runs.length === 1
      )
      yield* send(actor, { ...start, id: "second" })
      yield* Effect.yieldNow
      expect(calls).toBe(1)
    }).pipe(Effect.scoped)
)
