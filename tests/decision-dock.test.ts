import { it } from "@effect/vitest"
import { send, waitFor } from "@xstate/effect"
import { Effect, Exit, Scope } from "effect"
import { expect } from "vitest"

import type { Approval } from "../src/access/contracts"
import { makeDecisionDockOwner } from "../src/features/access/decision-dock-owner"
import {
  decisionKey,
  pendingDecisions,
} from "../src/features/access/decision-dock.machine"

const first: Approval = {
  id: "one",
  turnId: "turn",
  tool: "run_command",
  input: '{"command":"echo one"}',
  createdAt: 1,
  expiresAt: 9000000000000,
  status: "pending",
  revision: 1,
}
const second = { ...first, id: "two", tool: "write_note" }
const view = { agentId: "home", approvals: [first, second] }

it.effect(
  "defers only local presentation and keeps every request pending",
  () =>
    Effect.gen(function* () {
      const actor = yield* makeDecisionDockOwner(view)
      yield* send(actor, { type: "DEFER", key: decisionKey(first) })
      yield* waitFor(actor, (s) => s.context.selected === decisionKey(second))
      expect(pendingDecisions(actor.getSnapshot().context)).toEqual([
        first,
        second,
      ])
      yield* send(actor, { type: "DEFER", key: decisionKey(second) })
      yield* waitFor(actor, (s) => s.context.selected === null)
      expect(pendingDecisions(actor.getSnapshot().context)).toHaveLength(2)
      yield* send(actor, { type: "QUEUE" })
      yield* send(actor, { type: "SELECT", key: decisionKey(first) })
      yield* waitFor(
        actor,
        (s) => s.matches("queue") && s.context.selected === decisionKey(first)
      )
      expect(actor.getSnapshot().context.deferred).toEqual([
        decisionKey(second),
      ])
    }).pipe(Effect.scoped)
)

it.effect("selection and review cannot move a busy or uncertain request", () =>
  Effect.gen(function* () {
    const actor = yield* makeDecisionDockOwner(view)
    yield* send(actor, { type: "LOCK", key: decisionKey(first), locked: true })
    yield* send(actor, { type: "DEFER", key: decisionKey(first) })
    yield* send(actor, { type: "SELECT", key: decisionKey(second) })
    yield* send(actor, {
      type: "REVIEW",
      key: decisionKey(first),
      fromQueue: false,
    })
    yield* waitFor(actor, (s) => s.matches("review"))
    expect(actor.getSnapshot().context.selected).toBe(decisionKey(first))
    expect(actor.getSnapshot().context.deferred).toEqual([])
    yield* send(actor, { type: "CLOSE" })
    yield* waitFor(actor, (s) => s.matches("compact"))
    expect(actor.getSnapshot().context.locked).toBe(true)
  }).pipe(Effect.scoped)
)

it.effect(
  "acknowledges allow and deny once without calling execution complete",
  () =>
    Effect.gen(function* () {
      const actor = yield* makeDecisionDockOwner(view)
      yield* send(actor, {
        type: "ACKNOWLEDGED",
        key: decisionKey(first),
        approve: true,
      })
      yield* waitFor(actor, (s) => s.context.selected === decisionKey(second))
      expect(actor.getSnapshot().context.notice).toBe(
        "Approval accepted. Waiting for action status."
      )
      expect(pendingDecisions(actor.getSnapshot().context)).toEqual([second])
      yield* send(actor, {
        type: "VIEW",
        agentId: "home",
        approvals: [{ ...first, status: "approved", revision: 2 }, second],
      })
      yield* waitFor(actor, (s) => s.context.notice === "")
      yield* send(actor, {
        type: "ACKNOWLEDGED",
        key: decisionKey(second),
        approve: false,
      })
      yield* waitFor(actor, (s) => s.context.selected === null)
      expect(actor.getSnapshot().context.notice).toBe("Action declined.")
      yield* send(actor, {
        type: "VIEW",
        agentId: "home",
        approvals: [
          { ...first, status: "done", revision: 3 },
          { ...second, status: "denied", revision: 2 },
        ],
      })
      yield* waitFor(actor, (s) => s.context.notice === "")
      expect(pendingDecisions(actor.getSnapshot().context)).toEqual([])
    }).pipe(Effect.scoped)
)

it.effect(
  "replacement inputs, rounds and agent identities require a fresh review",
  () =>
    Effect.gen(function* () {
      for (const replacement of [
        { ...first, input: "different complete scope" },
        { ...first, revision: 2 },
        { ...first, turnId: "replacement" },
      ]) {
        const actor = yield* makeDecisionDockOwner({
          agentId: "home",
          approvals: [first],
        })
        yield* send(actor, {
          type: "REVIEW",
          key: decisionKey(first),
          fromQueue: false,
        })
        yield* waitFor(actor, (s) => s.matches("review"))
        yield* send(actor, {
          type: "VIEW",
          agentId: "home",
          approvals: [replacement],
        })
        yield* waitFor(
          actor,
          (s) =>
            s.matches("compact") &&
            s.context.selected === decisionKey(replacement)
        )
        yield* send(actor, {
          type: "REVIEW",
          key: decisionKey(first),
          fromQueue: false,
        })
        yield* send(actor, { type: "DEFER", key: decisionKey(first) })
        yield* send(actor, {
          type: "ACKNOWLEDGED",
          key: decisionKey(first),
          approve: true,
        })
        yield* send(actor, { type: "QUEUE" })
        yield* waitFor(actor, (s) => s.matches("queue"))
        expect(actor.getSnapshot().context.selected).toBe(
          decisionKey(replacement)
        )
        expect(actor.getSnapshot().context.acknowledged).toEqual([])
      }
      const actor = yield* makeDecisionDockOwner(view)
      yield* send(actor, { type: "DEFER", key: decisionKey(first) })
      yield* send(actor, {
        type: "VIEW",
        agentId: "another",
        approvals: [first],
      })
      yield* waitFor(actor, (s) => s.context.view.agentId === "another")
      expect(actor.getSnapshot().context.deferred).toEqual([])
      expect(actor.getSnapshot().context.selected).toBe(decisionKey(first))
    }).pipe(Effect.scoped)
)

it.effect(
  "the presentation owner closes with its scope and rejects malformed events",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const actor = yield* makeDecisionDockOwner(view).pipe(
        Effect.provideService(Scope.Scope, scope)
      )
      yield* send(actor, { type: "SELECT", key: 42 } as never)
      yield* send(actor, { type: "QUEUE" })
      yield* waitFor(actor, (s) => s.matches("queue"))
      expect(actor.getSnapshot().context.selected).toBe(decisionKey(first))
      yield* Scope.close(scope, Exit.void)
      expect(actor.getSnapshot().status).toBe("stopped")
    })
)
