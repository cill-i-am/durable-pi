import { it } from "@effect/vitest"
import { Clock, Deferred, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, test } from "vitest"
import { initialTransition, transition } from "xstate"

import type { InteractiveRuntime } from "../src/terminal/runtime"
import {
  makeInteractiveSession,
  type TerminalRelay,
} from "../src/terminal/session"
import { terminalSessionMachine } from "../src/terminal/session.machine"

const handshake = {
  accept: () => {
    throw new Error("Abstract test relay does not open a native socket")
  },
  transfer: () => {},
}
const runtime: InteractiveRuntime = {
  connect: () => Effect.succeed(handshake),
  close: () => Effect.void,
  settle: () => Effect.void,
}
const relay: TerminalRelay = (_open, _allow, close) => ({
  response: new Response(),
  close,
})
const request = () => new Request("https://terminal.internal")

describe("owned terminal session machine", () => {
  it.effect(
    "renewal cancels the previous lease timer without extending the fixed lifetime",
    () =>
      Effect.gen(function* () {
        const controller = new AbortController()
        const session = yield* makeInteractiveSession(
          "lease",
          controller,
          relay,
          yield* Clock.Clock
        )
        expect(session.state().phase).toBe("starting")
        yield* TestClock.adjust("29 seconds")
        yield* session.renew()
        yield* session.ready(runtime)
        expect(session.state().phase).toBe("ready")
        yield* TestClock.adjust("1 second")
        expect(controller.signal.aborted).toBe(false)
        expect(session.live).toBe(true)
        yield* TestClock.adjust("29 seconds")
        expect(controller.signal.aborted).toBe(true)
        expect(session.live).toBe(false)
        expect(Exit.isFailure(yield* Effect.exit(session.renew()))).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(session.ready(runtime)))).toBe(
          true
        )
      }).pipe(Effect.scoped)
  )

  it.effect(
    "saving ends lease renewal and closes the current relay before completion",
    () =>
      Effect.gen(function* () {
        const controller = new AbortController()
        let closed = false
        const session = yield* makeInteractiveSession(
          "save",
          controller,
          (_open, _allow, onClose) => ({
            response: new Response(),
            close: () => {
              closed = true
              onClose()
            },
          }),
          yield* Clock.Clock
        )
        expect(Exit.isFailure(yield* Effect.exit(session.save()))).toBe(true)
        yield* session.ready(runtime)
        yield* session.connect(request())
        yield* session.save()
        yield* session.completion
        expect(closed).toBe(true)
        expect(session.phase).toBe("saving")
        expect(Exit.isFailure(yield* Effect.exit(session.renew()))).toBe(true)
        expect(
          Exit.isFailure(yield* Effect.exit(session.connect(request())))
        ).toBe(true)
        yield* TestClock.adjust("31 seconds")
        // The enclosing command owns its shorter checkpoint/save deadline.
        expect(controller.signal.aborted).toBe(false)
      }).pipe(Effect.scoped)
  )

  it.effect(
    "retains the connection reservation while interrupted native startup cleanup is joined",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const cleaning = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let connections = 0
        const session = yield* makeInteractiveSession(
          "reservation",
          new AbortController(),
          relay,
          yield* Clock.Clock
        )
        yield* session.ready({
          ...runtime,
          connect: () =>
            Effect.suspend(() =>
              ++connections === 1
                ? Effect.acquireRelease(
                    Deferred.succeed(entered, undefined),
                    () =>
                      Deferred.succeed(cleaning, undefined).pipe(
                        Effect.andThen(Deferred.await(release))
                      )
                  ).pipe(Effect.andThen(Effect.never))
                : Effect.succeed(handshake)
            ),
        })
        const first = yield* Effect.forkChild(session.connect(request()))
        yield* Deferred.await(entered)
        expect(
          Exit.isFailure(yield* Effect.exit(session.connect(request())))
        ).toBe(true)
        const interrupted = yield* Effect.forkChild(Fiber.interrupt(first))
        yield* Deferred.await(cleaning)
        expect(interrupted.pollUnsafe()).toBeUndefined()
        expect(
          Exit.isFailure(yield* Effect.exit(session.connect(request())))
        ).toBe(true)
        expect(connections).toBe(1)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(interrupted)
        yield* session.connect(request())
        expect(connections).toBe(2)
      }).pipe(Effect.scoped)
  )

  it.effect(
    "fences a prior relay close callback after a new panel acquired ownership",
    () =>
      Effect.gen(function* () {
        const closed: (() => void)[] = []
        const session = yield* makeInteractiveSession(
          "fence",
          new AbortController(),
          (_open, _allow, onClose) => {
            closed.push(onClose)
            return { response: new Response(), close: onClose }
          },
          yield* Clock.Clock
        )
        yield* session.ready(runtime)
        yield* session.connect(request())
        closed[0]!()
        yield* session.connect(request())
        closed[0]!()
        expect(
          Exit.isFailure(yield* Effect.exit(session.connect(request())))
        ).toBe(true)
        expect(closed).toHaveLength(2)
      }).pipe(Effect.scoped)
  )

  it.effect(
    "duplicate readiness cannot replace the runtime held by the current session",
    () =>
      Effect.gen(function* () {
        const closes: string[] = []
        const session = yield* makeInteractiveSession(
          "ready",
          new AbortController(),
          relay,
          yield* Clock.Clock
        )
        yield* session.ready({
          ...runtime,
          close: () =>
            Effect.sync(() => {
              closes.push("first")
            }),
        })
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              session.ready({
                ...runtime,
                close: () =>
                  Effect.sync(() => {
                    closes.push("second")
                  }),
              })
            )
          )
        ).toBe(true)
        yield* session.closeRuntime()
        expect(closes).toEqual(["first"])
      }).pipe(Effect.scoped)
  )

  test("runtime event validation rejects malformed lease commands", () => {
    const machine = terminalSessionMachine({
      now: () => 0,
      stopped: () => false,
      complete: Effect.void,
      end: Effect.void,
    })
    const [state] = initialTransition(machine)
    for (const event of [
      { type: "RENEW", reply: null },
      { type: "CLAIM", connection: 3, reply: Deferred.makeUnsafe<void>() },
    ]) {
      const [unchanged, effects] = transition(machine, state, event as never)
      expect(unchanged).toBe(state)
      expect(effects).toMatchObject([
        { type: "@xstate.deadLetter", reason: "invalidEvent" },
      ])
    }
  })
})
