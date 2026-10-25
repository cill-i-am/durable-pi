import { it } from "@effect/vitest"
import { createEffectActor, send, waitFor } from "@xstate/effect"
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, test } from "vitest"
import { initialTransition, transition } from "xstate"
import {
  adjacencyMapToArray,
  getAdjacencyMap,
  getShortestPaths,
} from "xstate/graph"

import { makeLab } from "../src/stories/state/lab-owner"
import {
  applyLabCompletion,
  LabIssue,
  labMachine,
  labStates,
  labEdges,
  labStatus,
  type LabEvent,
  type LabPorts,
  type LabResult,
  type LabSnapshot,
} from "../src/stories/state/lab.machine"

const start = { type: "START", scenario: "success", delayMs: 10 } as const
const neverPorts: LabPorts = {
  run: () => Effect.never,
  check: () => Effect.never,
  cancel: () => Effect.void,
}
const taskValue = (state: LabSnapshot) => JSON.stringify(state.value.task)

describe("lab model coverage", () => {
  test("the frozen examination graph is projected from executable transitions", () => {
    expect(labStates).toEqual(
      expect.arrayContaining([
        "task.idle",
        "task.active.loading",
        "task.success",
        "task.error",
        "task.uncertain",
        "task.cancelled",
        "pointer.hover",
        "pointer.pressed",
        "focus.focused",
        "availability.disabled",
      ])
    )
    expect(labEdges).toEqual(
      expect.arrayContaining([
        { from: "task.idle", event: "START", to: "task.active.loading" },
        { from: "task.uncertain", event: "CHECK", to: "task.active.loading" },
      ])
    )
    expect(
      labEdges.some(
        (edge) => edge.from === "task.uncertain" && edge.event === "RETRY"
      )
    ).toBe(false)
    expect(
      Object.isFrozen(labStates) &&
        Object.isFrozen(labEdges) &&
        labEdges.every(Object.isFrozen)
    ).toBe(true)
  })
  const machine = labMachine(neverPorts)
  const events = (state: LabSnapshot) =>
    [
      start,
      { type: "RETRY" },
      { type: "CHECK" },
      { type: "CANCEL" },
      { type: "RESET" },
      { type: "ENABLE" },
      { type: "DISABLE" },
      ...(state.matches({ task: "active" }) && state.context.request
        ? [
            Exit.succeed({ kind: "success", receipt: "receipt" } as const),
            Exit.succeed({
              kind: "uncertain",
              message: "Check the result",
            } as const),
            Exit.succeed({ kind: "cancelled" } as const),
            Exit.fail(new LabIssue({ message: "Rejected" })),
          ].map((exit) => ({
            type: "xstate.done.actor" as const,
            actorId: "lab-work",
            output: {
              id: state.context.request!.id,
              generation: state.context.request!.generation,
              exit,
            },
          }))
        : []),
    ] as const
  const options = {
    events,
    serializeState: (state: LabSnapshot) =>
      JSON.stringify({
        value: state.value,
        availability: state.context.availability,
        mode: state.context.mode,
        intent: state.context.intent,
      }),
    limit: 1000,
  }
  test("every command outcome is reachable from the actual machine definition", () => {
    const paths = getShortestPaths(machine, options)
    expect(new Set(paths.map(({ state }) => labStatus(state)))).toEqual(
      new Set(["idle", "loading", "success", "error", "uncertain", "cancelled"])
    )
    expect(
      paths.some(({ state }) => state.context.availability === "disabled")
    ).toBe(true)
  })
  test("covers command admission, alternate outcomes, explicit retry, cancellation, reset and check edges", () => {
    const edges = adjacencyMapToArray(getAdjacencyMap(machine, options))
    const has = (before: string, event: string, after: string) =>
      edges.some(
        (edge) =>
          taskValue(edge.state) === before &&
          edge.event.type === event &&
          taskValue(edge.nextState) === after
      )
    for (const [before, event, after] of [
      ['"idle"', "START", '{"active":"loading"}'],
      ['{"active":"loading"}', "xstate.done.actor", '"success"'],
      ['{"active":"loading"}', "xstate.done.actor", '"error"'],
      ['{"active":"loading"}', "xstate.done.actor", '"uncertain"'],
      ['"error"', "RETRY", '{"active":"loading"}'],
      ['"uncertain"', "CHECK", '{"active":"loading"}'],
      ['{"active":"loading"}', "CANCEL", '{"active":"cancelling"}'],
      ['{"active":"cancelling"}', "xstate.done.actor", '"cancelled"'],
      ['{"active":"loading"}', "RESET", '{"active":"resetting"}'],
      ['{"active":"resetting"}', "xstate.done.actor", '"idle"'],
    ])
      expect(has(before!, event!, after!)).toBe(true)
  })
  test("pointer, focus and availability are independent machine-owned dimensions", () => {
    let [state] = initialTransition(machine)
    const advance = (event: LabEvent) => {
      state = transition(machine, state, event)[0]
    }
    advance({ type: "POINTER_ENTER" })
    advance({ type: "FOCUS" })
    expect(
      state.matches({ pointer: "hover", focus: "focused", task: "idle" })
    ).toBe(true)
    advance({ type: "POINTER_DOWN" })
    expect(state.matches({ pointer: "pressed", focus: "focused" })).toBe(true)
    advance({ type: "DISABLE" })
    expect(state.context.availability).toBe("disabled")
    advance(start)
    advance({ type: "POINTER_DOWN" })
    expect(state.matches({ task: "idle", pointer: "idle" })).toBe(true)
    advance({ type: "ENABLE" })
    advance(start)
    expect(labStatus(state)).toBe("loading")
  })
  test("malformed events are dead letters and cannot dispatch an invocation", () => {
    const [state] = initialTransition(machine)
    for (const event of [
      { ...start, scenario: "invented" },
      { ...start, delayMs: -1 },
      { ...start, delayMs: "10" },
      { type: "UNKNOWN" },
    ]) {
      const [next, effects] = transition(machine, state, event as never)
      expect(next).toBe(state)
      expect(effects).toMatchObject([
        { type: "@xstate.deadLetter", reason: "invalidEvent" },
      ])
    }
  })
  test("a completion from a prior generation or request cannot change the current operation", () => {
    const [state] = initialTransition(machine)
    const [running] = transition(machine, state, start)
    const context = running.context
    for (const request of [
      { id: "retired", generation: context.generation },
      { id: context.request!.id, generation: context.generation - 1 },
    ])
      expect(
        applyLabCompletion(context, {
          ...request,
          exit: Exit.succeed({ kind: "success", receipt: "stale" }),
        })
      ).toBeUndefined()
  })
})

describe("executed Effect simulations", () => {
  it.effect(
    "advances loading to success through an actual Effect-clock completion",
    () =>
      Effect.gen(function* () {
        const { actor, simulation } = yield* makeLab()
        yield* send(actor, start)
        yield* waitFor(actor, (state) => state.matches({ task: "active" }))
        expect(labStatus(actor.getSnapshot())).toBe("loading")
        yield* TestClock.adjust(10)
        const state = yield* waitFor(actor, (value) =>
          value.matches({ task: "success" })
        )
        expect(state.context.receipt).toBe(
          `receipt:${state.context.request!.id}`
        )
        expect(simulation.activeCount()).toBe(0)
        expect(simulation.trace.at(-1)).toBe(
          `released:${state.context.request!.id}`
        )
      }).pipe(Effect.scoped)
  )
  it.effect(
    "an explicit retry uses the captured request and can recover a scripted failure",
    () =>
      Effect.gen(function* () {
        const { actor, simulation } = yield* makeLab()
        yield* send(actor, { ...start, scenario: "error" })
        yield* TestClock.adjust(10)
        const failed = yield* waitFor(actor, (state) =>
          state.matches({ task: "error" })
        )
        const request = failed.context.request
        yield* TestClock.adjust(1000)
        expect(
          simulation.trace.filter((line) => line.startsWith("started:"))
        ).toHaveLength(1)
        yield* send(actor, { type: "RETRY" })
        yield* TestClock.adjust(10)
        const success = yield* waitFor(actor, (state) =>
          state.matches({ task: "success" })
        )
        expect(success.context.request).toEqual(request)
        expect(simulation.receiptCount()).toBe(1)
      }).pipe(Effect.scoped)
  )
  it.effect(
    "uncertainty never resends; checking recovers the one simulated receipt",
    () =>
      Effect.gen(function* () {
        const { actor, simulation } = yield* makeLab()
        yield* send(actor, { ...start, scenario: "uncertain" })
        yield* TestClock.adjust(10)
        yield* waitFor(actor, (state) => state.matches({ task: "uncertain" }))
        yield* send(actor, { type: "RETRY" })
        yield* send(actor, start)
        yield* TestClock.adjust(1000)
        expect(
          simulation.trace.filter((line) => line.startsWith("committed:"))
        ).toHaveLength(1)
        expect(labStatus(actor.getSnapshot())).toBe("uncertain")
        yield* send(actor, { type: "CHECK" })
        yield* TestClock.adjust(10)
        yield* waitFor(actor, (state) => state.matches({ task: "success" }))
        expect(simulation.receiptCount()).toBe(1)
        expect(
          simulation.trace.filter((line) => line.startsWith("committed:"))
        ).toHaveLength(1)
      }).pipe(Effect.scoped)
  )
  it.effect(
    "immediate cancellation before the operation starts still releases the slot",
    () =>
      Effect.gen(function* () {
        const { actor, simulation } = yield* makeLab()
        yield* send(actor, { ...start, scenario: "hold" })
        yield* send(actor, { type: "CANCEL" })
        yield* waitFor(actor, (state) => state.matches({ task: "cancelled" }))
        expect(simulation.activeCount()).toBe(0)
        expect(simulation.receiptCount()).toBe(0)
      }).pipe(Effect.scoped)
  )
  it.effect(
    "cancel and reset retain occupancy until the resource finalizer joins",
    () =>
      Effect.gen(function* () {
        for (const type of ["CANCEL", "RESET"] as const) {
          const entered = yield* Deferred.make<void>(),
            cleanup = yield* Deferred.make<void>(),
            release = yield* Deferred.make<void>(),
            result = yield* Deferred.make<LabResult>()
          let calls = 0
          const actor = yield* createEffectActor(
            labMachine({
              run: () =>
                Effect.acquireRelease(
                  Effect.sync(() => {
                    calls++
                  }).pipe(Effect.andThen(Deferred.succeed(entered, undefined))),
                  () =>
                    Deferred.succeed(cleanup, undefined).pipe(
                      Effect.andThen(Deferred.await(release))
                    )
                ).pipe(Effect.andThen(Deferred.await(result))),
              check: () => Effect.never,
              cancel: () =>
                Deferred.succeed(result, { kind: "cancelled" }).pipe(
                  Effect.asVoid
                ),
            })
          )
          yield* send(actor, start)
          yield* Deferred.await(entered)
          yield* send(actor, { type })
          yield* Deferred.await(cleanup)
          expect(labStatus(actor.getSnapshot())).toBe("loading")
          yield* send(actor, start)
          yield* send(actor, { type: "RETRY" })
          expect(calls).toBe(1)
          yield* Deferred.succeed(release, undefined)
          yield* waitFor(actor, (state) =>
            state.matches({ task: type === "RESET" ? "idle" : "cancelled" })
          )
          if (type === "RESET")
            expect(actor.getSnapshot().context.request).toBeNull()
        }
      }).pipe(Effect.scoped)
  )
  it.effect(
    "reset fences a late success and never restores a retired result",
    () =>
      Effect.gen(function* () {
        const result = yield* Deferred.make<LabResult>(),
          entered = yield* Deferred.make<void>()
        const actor = yield* createEffectActor(
          labMachine({
            run: () =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(result))
              ),
            check: () => Effect.never,
            cancel: () => Effect.void,
          })
        )
        yield* send(actor, start)
        yield* Deferred.await(entered)
        yield* send(actor, { type: "RESET" })
        yield* waitFor(actor, (state) =>
          state.matches({ task: { active: "resetting" } })
        )
        yield* Deferred.succeed(result, { kind: "success", receipt: "late" })
        yield* waitFor(actor, (state) => state.matches({ task: "idle" }))
        expect(actor.getSnapshot().context.receipt).toBe("")
        expect(actor.getSnapshot().context.generation).toBe(1)
      }).pipe(Effect.scoped)
  )
  it.effect(
    "failed cancellation cleanup retains its full Cause and cannot authorize retry",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>(),
          result = yield* Deferred.make<LabResult>()
        const defect = new Error("cleanup failed")
        let runs = 0
        const actor = yield* createEffectActor(
          labMachine({
            run: () =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  runs++
                }).pipe(Effect.andThen(Deferred.succeed(entered, undefined))),
                () => Effect.die(defect)
              ).pipe(Effect.andThen(Deferred.await(result))),
            check: () => Effect.never,
            cancel: () =>
              Deferred.succeed(result, { kind: "cancelled" }).pipe(
                Effect.asVoid
              ),
          })
        )
        yield* send(actor, start)
        yield* Deferred.await(entered)
        yield* send(actor, { type: "CANCEL" })
        const state = yield* waitFor(actor, (value) =>
          value.matches({ task: "error" })
        )
        expect(
          Cause.isCause(state.context.failure) &&
            Cause.hasDies(state.context.failure)
        ).toBe(true)
        expect(
          Cause.isCause(state.context.failure) &&
            state.context.failure.reasons.some(
              (reason) => reason._tag === "Die" && reason.defect === defect
            )
        ).toBe(true)
        yield* send(actor, { type: "RETRY" })
        yield* Effect.yieldNow
        expect(runs).toBe(1)
      }).pipe(Effect.scoped)
  )
  it.effect(
    "unmount scope closure joins held cleanup before reporting disposal",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>(),
          cleanup = yield* Deferred.make<void>(),
          release = yield* Deferred.make<void>(),
          scope = yield* Scope.make()
        const actor = yield* createEffectActor(
          labMachine({
            run: () =>
              Effect.acquireRelease(Deferred.succeed(entered, undefined), () =>
                Deferred.succeed(cleanup, undefined).pipe(
                  Effect.andThen(Deferred.await(release))
                )
              ).pipe(Effect.andThen(Effect.never)),
            check: () => Effect.never,
            cancel: () => Effect.void,
          })
        ).pipe(Effect.provideService(Scope.Scope, scope))
        yield* send(actor, start)
        yield* Deferred.await(entered)
        const closed = yield* Scope.close(scope, Exit.void).pipe(
          Effect.forkChild
        )
        yield* Deferred.await(cleanup)
        expect(closed.pollUnsafe()).toBeUndefined()
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(closed)
        expect(actor.getSnapshot().status).toBe("stopped")
      }).pipe(Effect.scoped)
  )
})
