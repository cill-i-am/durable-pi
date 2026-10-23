import { it as effectIt } from "@effect/vitest"
import { Clock, Effect } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"

import {
  validTerminalInput,
  relayTerminal,
} from "../src/terminal/adapters/socket"
import { makeInteractiveSession } from "../src/terminal/session"

describe("terminal transport boundary", () => {
  it("accepts only bounded binary input and a bounded resize control", () => {
    expect(validTerminalInput(new ArrayBuffer(16384))).toBe(true)
    expect(validTerminalInput(new ArrayBuffer(16385))).toBe(false)
    expect(
      validTerminalInput(JSON.stringify({ type: "resize", cols: 80, rows: 24 }))
    ).toBe(true)
    for (const data of [
      "rm -rf /",
      '{"type":"exec","command":"whoami"}',
      '{"type":"resize","cols":1000,"rows":24}',
      '{"type":"resize","cols":80,"rows":24,"url":"https://evil.example"}',
    ])
      expect(validTerminalInput(data)).toBe(false)
  })
  effectIt.effect(
    "limits authenticated renewal to the fixed session lifetime",
    () =>
      Effect.gen(function* () {
        const controller = new AbortController()
        const session = yield* makeInteractiveSession(
          "id",
          controller,
          relayTerminal,
          yield* Clock.Clock
        )
        const maximum = session.maximumAt
        for (let i = 0; i < 59; i++) {
          yield* TestClock.adjust("10 seconds")
          yield* session.renew()
        }
        expect(session.maximumAt).toBe(maximum)
        expect(session.expiresAt).toBe(maximum)
        yield* TestClock.adjust("10001 millis")
        expect(controller.signal.aborted).toBe(true)
        expect(yield* Effect.result(session.renew())).toMatchObject({
          _tag: "Failure",
        })
      }).pipe(Effect.scoped)
  )
})
