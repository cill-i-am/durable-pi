import { it } from "@effect/vitest"
import { createEffectActor, send, type EffectActor } from "@xstate/effect"
import { Deferred, Effect } from "effect"
import { expect } from "vitest"

import {
  terminalServiceHostMachine,
  type HostCheck,
  type HostObservation,
  type HostPermission,
} from "../src/terminal/service-host.machine"

type Host = EffectActor<typeof terminalServiceHostMachine>
const observe = (actor: Host, type: HostObservation) =>
  Effect.gen(function* () {
    const ack = yield* Deferred.make<void>()
    yield* send(actor, { type, ack })
    yield* Deferred.await(ack)
  })
const check = (actor: Host, mode: HostCheck, active = false) =>
  Effect.gen(function* () {
    const reply = yield* Deferred.make<HostPermission>()
    yield* send(actor, { type: "CHECK", mode, active, reply })
    return yield* Deferred.await(reply)
  })

it.effect(
  "orders later admission behind an enqueued shutdown without waiting for its acknowledgement",
  () =>
    Effect.gen(function* () {
      const host = yield* createEffectActor(terminalServiceHostMachine)
      const ack = yield* Deferred.make<void>()
      yield* send(host, { type: "CLOSE", ack })
      expect(yield* check(host, "open")).toBe("stopped")
      // Resource availability cannot grant host admission by itself.
      expect(yield* check(host, "resources")).toBe("allow")
      expect(yield* check(host, "recover")).toBe("stopped")
      yield* Deferred.await(ack)
    }).pipe(Effect.scoped)
)

it.effect(
  "keeps an already accepted recovery joinable during shutdown and never reopens admission",
  () =>
    Effect.gen(function* () {
      const host = yield* createEffectActor(terminalServiceHostMachine)
      expect(yield* check(host, "recover")).toBe("allow")
      // The admitted SQL recovery can finish acquiring ownership after CLOSE.
      yield* observe(host, "CLOSE")
      yield* observe(host, "RECOVERY_STARTED")
      expect(yield* check(host, "recover")).toBe("join")
      expect(yield* check(host, "open")).toBe("stopped")
      yield* observe(host, "RECOVERY_FINISHED")
      expect(yield* check(host, "recover")).toBe("stopped")
    }).pipe(Effect.scoped)
)

it.effect(
  "retains failed native cleanup without command rows until explicit recovery joins",
  () =>
    Effect.gen(function* () {
      const host = yield* createEffectActor(terminalServiceHostMachine)
      expect(
        host.getSnapshot().can({ type: "CONFIGURE_NETWORK", active: false })
      ).toBe(true)
      yield* observe(host, "CLEANUP_FAILED")
      expect(yield* check(host, "resources")).toBe("cleanup")
      // Exact command replay has no new native admission.
      expect(yield* check(host, "open")).toBe("allow")
      expect(
        host.getSnapshot().can({ type: "CONFIGURE_NETWORK", active: false })
      ).toBe(false)
      expect(yield* check(host, "recover", true)).toBe("active")
      expect(yield* check(host, "recover")).toBe("allow")
      yield* observe(host, "RECOVERY_STARTED")
      expect(yield* check(host, "resources")).toBe("cleanup")
      yield* observe(host, "CLEANUP_FAILED")
      expect(host.getSnapshot().matches({ cleanup: "recovering" })).toBe(true)
      expect(yield* check(host, "recover")).toBe("join")
      yield* observe(host, "RECOVERY_FINISHED")
      expect(yield* check(host, "resources")).toBe("cleanup")
      yield* observe(host, "RECOVERY_STARTED")
      yield* observe(host, "RECOVERY_FINISHED")
      expect(yield* check(host, "resources")).toBe("allow")
      expect(host.getSnapshot().context.cleanupError).toBeNull()
      expect(
        host.getSnapshot().can({ type: "CONFIGURE_NETWORK", active: true })
      ).toBe(false)
    }).pipe(Effect.scoped)
)

it.effect(
  "rejects malformed lifecycle observations without changing cleanup knowledge",
  () =>
    Effect.gen(function* () {
      const host = yield* createEffectActor(terminalServiceHostMachine)
      // Exercise runtime validation through the real actor mailbox.
      host.send({ type: "CLEANUP_FAILED", ack: null } as never)
      expect(yield* check(host, "resources")).toBe("allow")
      expect(host.getSnapshot().context.cleanupError).toBeNull()
    }).pipe(Effect.scoped)
)
