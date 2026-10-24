import { it } from "@effect/vitest"
import { send, waitFor } from "@xstate/effect"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { expect } from "vitest"
import { initialTransition, transition } from "xstate"

import { homeAgentId } from "../src/agents/contracts"
import { makeWorkspaceCommand } from "../src/app/use-workspace-command"
import { makeWorkspaceLinkRetry } from "../src/app/use-workspace-link-retry"
import { workspaceCommandMachine } from "../src/app/workspace-command.machine"
import type { WorkspaceCommand } from "../src/app/workspace-command.machine"

it.effect(
  "close completion dispatches the captured current agent once and ignores duplicate choices",
  () =>
    Effect.gen(function* () {
      const calls: WorkspaceCommand[] = []
      const owner = yield* makeWorkspaceCommand({
        locked: () => false,
        dispatch: (command) => {
          calls.push(command)
        },
        listen: () => () => {},
      })
      yield* send(owner.actor, { type: "OPEN" })
      yield* waitFor(owner.actor, (state) => state.matches("open"))
      const revision = owner.actor.getSnapshot().context.revision
      yield* send(owner.actor, {
        type: "CHOOSE",
        command: { kind: "agent", id: homeAgentId },
      })
      yield* send(owner.actor, {
        type: "CHOOSE",
        command: { kind: "action", id: "files" },
      })
      yield* waitFor(owner.actor, (state) => state.matches("closing"))
      expect(calls).toEqual([])
      expect(owner.actor.getSnapshot().context.skipFocus).toBe(true)
      yield* send(owner.actor, { type: "CLOSED", revision })
      yield* waitFor(owner.actor, (state) => state.matches("closed"))
      yield* send(owner.actor, { type: "CLOSED", revision })
      yield* Effect.yieldNow
      expect(calls).toEqual([{ kind: "agent", id: homeAgentId }])
    }).pipe(Effect.scoped)
)

it.effect(
  "a late close cannot dispatch into a reopened search or replace its newer command",
  () =>
    Effect.gen(function* () {
      const calls: WorkspaceCommand[] = []
      const owner = yield* makeWorkspaceCommand({
        locked: () => false,
        dispatch: (command) => {
          calls.push(command)
        },
        listen: () => () => {},
      })
      yield* send(owner.actor, { type: "OPEN" })
      yield* waitFor(owner.actor, (state) => state.matches("open"))
      const old = owner.actor.getSnapshot().context.revision
      yield* send(owner.actor, {
        type: "CHOOSE",
        command: { kind: "action", id: "files" },
      })
      yield* send(owner.actor, { type: "OPEN" })
      yield* waitFor(
        owner.actor,
        (state) => state.matches("open") && state.context.revision !== old
      )
      const revision = owner.actor.getSnapshot().context.revision
      yield* send(owner.actor, {
        type: "CHOOSE",
        command: { kind: "action", id: "memory" },
      })
      yield* send(owner.actor, { type: "CLOSED", revision: old })
      yield* Effect.yieldNow
      expect(calls).toEqual([])
      yield* send(owner.actor, { type: "CLOSED", revision })
      yield* waitFor(owner.actor, (state) => state.matches("closed"))
      expect(calls).toEqual([{ kind: "action", id: "memory" }])
    }).pipe(Effect.scoped)
)

it.effect(
  "current lock revokes deferred dispatch and scope closes its keyboard listener",
  () =>
    Effect.gen(function* () {
      let locked = false,
        calls = 0,
        listeners = 0
      const scope = yield* Scope.make()
      const owner = yield* makeWorkspaceCommand({
        locked: () => locked,
        dispatch: () => {
          calls++
        },
        listen: () => {
          listeners++
          return () => {
            listeners--
          }
        },
      }).pipe(Scope.provide(scope))
      yield* send(owner.actor, { type: "OPEN" })
      yield* waitFor(owner.actor, (state) => state.matches("open"))
      const revision = owner.actor.getSnapshot().context.revision
      yield* send(owner.actor, {
        type: "CHOOSE",
        command: { kind: "action", id: "files" },
      })
      yield* waitFor(owner.actor, (state) => state.matches("closing"))
      locked = true
      yield* send(owner.actor, { type: "CLOSED", revision })
      yield* waitFor(owner.actor, (state) => state.matches("closed"))
      locked = false
      yield* send(owner.actor, { type: "CLOSED", revision })
      yield* Scope.close(scope, Exit.void)
      expect(calls).toBe(0)
      expect(listeners).toBe(0)
    })
)

it.effect(
  "retry coalesces duplicate admission and resets once only after invalidation succeeds",
  () =>
    Effect.gen(function* () {
      let requests = 0,
        resets = 0
      const entered = yield* Deferred.make<void>()
      let release!: () => void
      const owner = yield* makeWorkspaceLinkRetry({
        current: () => true,
        invalidate: () => {
          requests++
          Deferred.doneUnsafe(entered, Effect.void)
          return new Promise<void>((resolve) => {
            release = resolve
          })
        },
        reset: () => {
          resets++
        },
      })
      yield* send(owner.actor, { type: "RETRY", owner: "original" })
      yield* Deferred.await(entered)
      yield* send(owner.actor, { type: "RETRY", owner: "original" })
      yield* send(owner.actor, { type: "RETRY", owner: "original" })
      yield* Effect.yieldNow
      expect(requests).toBe(1)
      expect(resets).toBe(0)
      release()
      yield* waitFor(owner.actor, (state) => state.matches("ready"))
      expect(resets).toBe(1)
    }).pipe(Effect.scoped)
)

it.effect("failed invalidation permits only an explicit retry", () =>
  Effect.gen(function* () {
    let requests = 0,
      resets = 0
    const owner = yield* makeWorkspaceLinkRetry({
      current: () => true,
      invalidate: async () => {
        if (++requests === 1) throw new Error("offline")
      },
      reset: () => {
        resets++
      },
    })
    yield* send(owner.actor, { type: "RETRY", owner: "original" })
    yield* waitFor(
      owner.actor,
      (state) => state.matches("ready") && !!state.context.failure
    )
    expect([requests, resets]).toEqual([1, 0])
    yield* send(owner.actor, { type: "RETRY", owner: "original" })
    yield* waitFor(
      owner.actor,
      (state) => state.matches("ready") && resets === 1
    )
    expect(requests).toBe(2)
  }).pipe(Effect.scoped)
)

for (const late of ["success", "compound"] as const)
  it.effect(
    `retirement joins native invalidation and fences late ${late}`,
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make(),
          entered = yield* Deferred.make<void>()
        let resolve!: () => void,
          reject!: (cause: unknown) => void,
          resets = 0
        const owner = yield* makeWorkspaceLinkRetry({
          current: () => true,
          invalidate: () => {
            Deferred.doneUnsafe(entered, Effect.void)
            return new Promise<void>((done, fail) => {
              resolve = done
              reject = fail
            })
          },
          reset: () => {
            resets++
          },
        }).pipe(Scope.provide(scope))
        yield* send(owner.actor, { type: "RETRY", owner: "original" })
        yield* Deferred.await(entered)
        owner.revoke()
        const closing = yield* Scope.close(scope, Exit.void).pipe(
          Effect.exit,
          Effect.forkChild
        )
        yield* Effect.yieldNow
        expect(closing.pollUnsafe()).toBeUndefined()
        if (late === "success") resolve()
        else {
          const annotation = Context.makeUnsafe(
            new Map([["workspace/retry-cleanup", "held-router"]])
          )
          reject(
            Cause.fromReasons([
              Cause.makeFailReason("late checked failure").annotate(annotation),
              Cause.makeInterruptReason(99201).annotate(annotation),
            ])
          )
        }
        const result = yield* Fiber.join(closing)
        expect(resets).toBe(0)
        expect(Exit.isSuccess(result)).toBe(late === "success")
        if (Exit.isFailure(result)) {
          expect(
            result.cause.reasons.some(
              (reason) =>
                reason._tag === "Die" &&
                typeof reason.defect === "object" &&
                reason.defect !== null &&
                "_tag" in reason.defect &&
                reason.defect._tag === "Fail" &&
                "error" in reason.defect &&
                reason.defect.error === "late checked failure" &&
                "annotations" in reason.defect &&
                reason.defect.annotations instanceof Map &&
                reason.defect.annotations.get("workspace/retry-cleanup") ===
                  "held-router"
            )
          ).toBe(true)
          expect(
            result.cause.reasons.some(
              (reason) =>
                reason._tag === "Interrupt" &&
                reason.fiberId === 99201 &&
                reason.annotations.get("workspace/retry-cleanup") ===
                  "held-router"
            )
          ).toBe(true)
          expect(
            result.cause.reasons.some(
              (reason) => reason._tag === "Die" && Cause.isCause(reason.defect)
            )
          ).toBe(false)
        }
      })
  )

it("rejects malformed deferred commands before admission", () => {
  const machine = workspaceCommandMachine({
    unlocked: () => true,
    dispatch: () => Effect.void,
  })
  const [initial] = initialTransition(machine)
  const [next, effects] = transition(machine, initial, {
    type: "CHOOSE",
    command: { kind: "agent", id: "not-an-agent-id" },
  } as never)
  expect(next).toBe(initial)
  expect(effects).toEqual([
    expect.objectContaining({
      type: "@xstate.deadLetter",
      reason: "invalidEvent",
    }),
  ])
})

it.effect(
  "a replacement error waits for the original invalidation and cannot receive its reset",
  () =>
    Effect.gen(function* () {
      let error: unknown = "original",
        requests = 0,
        resets = 0
      let release!: () => void
      const entered = yield* Deferred.make<void>(),
        second = yield* Deferred.make<void>()
      const owner = yield* makeWorkspaceLinkRetry({
        current: (requested) => requested === error,
        invalidate: () => {
          requests++
          const pending = new Promise<void>((resolve) => {
            release = resolve
          })
          Deferred.doneUnsafe(requests === 1 ? entered : second, Effect.void)
          return pending
        },
        reset: () => {
          resets++
        },
      })
      yield* send(owner.actor, { type: "RETRY", owner: "original" })
      yield* Deferred.await(entered)
      error = "replacement"
      yield* send(owner.actor, { type: "RETRY", owner: "replacement" })
      yield* Effect.yieldNow
      expect(requests).toBe(1)
      release()
      yield* waitFor(owner.actor, (state) => state.matches("ready"))
      expect(resets).toBe(0)
      yield* send(owner.actor, { type: "RETRY", owner: "replacement" })
      yield* Deferred.await(second)
      expect(requests).toBe(2)
      release()
      yield* waitFor(owner.actor, (state) => state.matches("ready"))
      expect(resets).toBe(1)
    }).pipe(Effect.scoped)
)

for (const withDefect of [false, true])
  it.effect(
    `successful retry cannot erase prior compound invalidation cleanup ${withDefect ? "with" : "without"} Die`,
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        let requests = 0,
          resets = 0
        const annotation = Context.makeUnsafe(
          new Map([["workspace/retry-retention", "first-attempt"]])
        )
        const cause = Cause.fromReasons([
          Cause.makeFailReason("retained checked failure").annotate(annotation),
          ...(withDefect
            ? [Cause.makeDieReason("retained defect").annotate(annotation)]
            : []),
          Cause.makeInterruptReason(99202).annotate(annotation),
        ])
        const owner = yield* makeWorkspaceLinkRetry({
          current: () => true,
          invalidate: async () => {
            if (++requests === 1) throw cause
          },
          reset: () => {
            resets++
          },
        }).pipe(Scope.provide(scope))
        yield* send(owner.actor, { type: "RETRY", owner: "original" })
        yield* waitFor(
          owner.actor,
          (state) => state.matches("ready") && !!state.context.failure
        )
        yield* send(owner.actor, { type: "RETRY", owner: "original" })
        yield* waitFor(
          owner.actor,
          (state) => state.matches("ready") && resets === 1
        )
        expect(requests).toBe(2)
        const closed = yield* Effect.exit(Scope.close(scope, Exit.void))
        expect(Exit.isFailure(closed)).toBe(true)
        if (Exit.isFailure(closed))
          expect(
            closed.cause.reasons.some(
              (reason) =>
                reason._tag === "Interrupt" &&
                reason.fiberId === 99202 &&
                reason.annotations.get("workspace/retry-retention") ===
                  "first-attempt"
            )
          ).toBe(true)
      })
  )
