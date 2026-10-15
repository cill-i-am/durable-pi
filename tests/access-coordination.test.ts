import { expect, it } from "@effect/vitest"
import { Cause, Clock, Context, Deferred, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { AccessStore } from "../src/access/adapters/sqlite"
import { AccessGate } from "../src/access/gate"
import type { AccessLedger } from "../src/access/ledger"
import { database } from "./database"

const intent = { id: "operation", turnId: "turn", tool: "test", input: "{}" }
const fixture = Effect.gen(function* () {
  const clock = yield* Clock.Clock
  const started = yield* Deferred.make<void>()
  const store = new AccessStore(
    database(),
    () => [{ name: "test", description: "Fixture", mode: "ask" }],
    () => clock.currentTimeMillisUnsafe()
  )
  const gate = new AccessGate(
    store,
    () => true,
    () => {
      Deferred.doneUnsafe(started, Effect.void)
    }
  )
  return { store, gate, started }
})

it.effect(
  "expires an approval on the Effect clock without dispatching work",
  () =>
    Effect.gen(function* () {
      const { store, gate, started } = yield* fixture
      let calls = 0
      const fiber = yield* Effect.forkChild(
        gate.run(
          intent,
          Effect.sync(() => ++calls)
        )
      )
      yield* Deferred.await(started)
      yield* TestClock.adjust("16 minutes")
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.hasFails(exit.cause)).toBe(true)
      expect(store.get(intent.id)?.status).toBe("expired")
      expect(calls).toBe(0)
    })
)

it.effect(
  "interrupts a waiter and leaves its durable approval available for an explicit resume",
  () =>
    Effect.gen(function* () {
      const { store, gate, started } = yield* fixture
      let calls = 0
      const work = Effect.sync(() => ++calls)
      const fiber = yield* Effect.forkChild(gate.run(intent, work))
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit))
        expect(Cause.hasInterrupts(exit.cause)).toBe(true)
      yield* gate.decide(intent.id, true, store.get(intent.id)!.revision)
      yield* TestClock.adjust("1 minute")
      expect(calls).toBe(0)
      expect(yield* gate.run(intent, work)).toBe(1)
      expect(yield* gate.run(intent, work)).toBe(1)
      expect(calls).toBe(1)
    })
)

it.effect(
  "retains a notification delivered between claiming and registering the wait",
  () =>
    Effect.gen(function* () {
      const { store } = yield* fixture
      const ledger: AccessLedger = {
        policies: () => store.policies(),
        pending: () => store.pending(),
        awaitingApproval: (id) => store.awaitingApproval(id),
        get: (id) => store.get(id),
        begin: (input) => store.begin(input),
        finish: (id, result) => store.finish(id, result),
        cancel: (id) => store.cancel(id),
        revoke: (name) => store.revoke(name),
        update: (name, revision, mode) => store.update(name, revision, mode),
        decide: (id, approve, revision, remember) =>
          store.decide(id, approve, revision, remember),
        claim: (id, recoverable) => {
          const decision = store.claim(id, recoverable)
          if (decision === "pending") {
            store.decide(id, true, store.get(id)!.revision)
            gate.notify()
          }
          return decision
        },
      }
      const gate = new AccessGate(ledger, () => true)
      expect(yield* gate.run(intent, Effect.succeed("saved"))).toBe("saved")
      expect(store.get(intent.id)?.status).toBe("done")
    })
)

class WorkValue extends Context.Service<WorkValue, { value: number }>()(
  "test/access/WorkValue"
) {}
it.effect(
  "preserves the caller's Effect requirements through authorized work",
  () =>
    Effect.gen(function* () {
      const { store, gate } = yield* fixture
      store.begin(intent)
      store.decide(intent.id, true, 0)
      const work = WorkValue.use((value) => Effect.succeed(value.value))
      expect(
        yield* gate
          .run(intent, work)
          .pipe(Effect.provideService(WorkValue, { value: 42 }))
      ).toBe(42)
    })
)
