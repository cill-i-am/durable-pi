import { it } from "@effect/vitest"
import { waitFor } from "@xstate/effect"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"

import { homeAgentId } from "../src/agents/contracts"
import { makeAgentStatuses } from "../src/features/agents/agent-statuses-owner"

it.effect(
  "status polling skips hidden tabs and joins one read before admitting another",
  () =>
    Effect.gen(function* () {
      let visible = false,
        calls = 0,
        listeners = 0,
        release!: () => void
      const entered = yield* Deferred.make<void>()
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const scope = yield* Scope.make()
      const owner = yield* makeAgentStatuses({
        membership: () => "home:active",
        visible: () => visible,
        listen: () => {
          listeners++
          return () => {
            listeners--
          }
        },
        read: async () => {
          calls++
          if (calls === 1) {
            Deferred.doneUnsafe(entered, Effect.void)
            await held
          }
          return {
            statuses: [
              { agentId: homeAgentId, state: "ready" as const, turnId: null },
            ],
          }
        },
      }).pipe(Effect.provideService(Scope.Scope, scope))
      yield* TestClock.adjust("1 minute")
      expect(calls).toBe(0)
      visible = true
      owner.inspect()
      yield* Deferred.await(entered)
      owner.inspect()
      owner.inspect()
      yield* Effect.yieldNow
      expect(calls).toBe(1)
      release()
      yield* waitFor(owner.actor, (state) => state.matches("waiting"))
      yield* TestClock.adjust("30 seconds")
      yield* waitFor(owner.actor, (state) => state.matches("waiting"))
      expect(calls).toBe(2)
      visible = false
      owner.inspect()
      yield* waitFor(owner.actor, (state) => state.matches("dormant"))
      yield* TestClock.adjust("1 minute")
      expect(calls).toBe(2)
      yield* Scope.close(scope, Exit.void)
      expect(listeners).toBe(0)
      visible = true
      owner.inspect()
      yield* Effect.yieldNow
      expect(calls).toBe(2)
    })
)

it.effect(
  "closing status observation removes the listener and retains held native occupancy",
  () =>
    Effect.gen(function* () {
      let release!: () => void,
        listeners = 0,
        aborted = false
      const entered = yield* Deferred.make<void>()
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const scope = yield* Scope.make()
      const owner = yield* makeAgentStatuses({
        membership: () => "home:active",
        visible: () => true,
        listen: () => {
          listeners++
          return () => {
            listeners--
          }
        },
        read: async (signal) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true
            },
            { once: true }
          )
          Deferred.doneUnsafe(entered, Effect.void)
          await held
          return { statuses: [] }
        },
      }).pipe(Effect.provideService(Scope.Scope, scope))
      yield* Deferred.await(entered)
      owner.revoke()
      const closing = yield* Scope.close(scope, Exit.void).pipe(
        Effect.forkChild
      )
      yield* Effect.yieldNow
      expect(closing.pollUnsafe()).toBeUndefined()
      expect(aborted).toBe(true)
      release()
      yield* Fiber.join(closing)
      expect(listeners).toBe(0)
      expect(owner.actor.getSnapshot().status).toBe("stopped")
    })
)

it.effect(
  "changed catalog membership refreshes after the held read and fences its old result",
  () =>
    Effect.gen(function* () {
      let membership = "home:active",
        calls = 0,
        release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const entered = yield* Deferred.make<void>()
      const owner = yield* makeAgentStatuses({
        membership: () => membership,
        visible: () => true,
        listen: () => () => {},
        read: async () => {
          calls++
          if (calls === 1) {
            Deferred.doneUnsafe(entered, Effect.void)
            await held
            return {
              statuses: [
                {
                  agentId: homeAgentId,
                  state: "working" as const,
                  turnId: null,
                },
              ],
            }
          }
          return {
            statuses: [
              { agentId: homeAgentId, state: "ready" as const, turnId: null },
            ],
          }
        },
      })
      yield* Deferred.await(entered)
      membership = "home:active,new:active"
      owner.inspect()
      yield* waitFor(owner.actor, (state) => state.context.queued)
      expect(calls).toBe(1)
      release()
      yield* waitFor(owner.actor, (state) => state.matches("waiting"))
      expect(calls).toBe(2)
      expect(owner.actor.getSnapshot().context.statuses[0]?.state).toBe("ready")
    }).pipe(Effect.scoped)
)
