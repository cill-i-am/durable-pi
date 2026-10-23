import { expect, it } from "vitest"

import {
  advanceMessage,
  messageStatus,
  type MessageControl,
} from "../src/coordination/message.machine"

const pending = (): MessageControl => ({
  schema_version: 1,
  workflow_version: 1,
  revision: 0,
  phase: "pending",
  attempts: 0,
  retry_at: 1000,
  error: null,
  attempt_id: null,
})
it("claims one attempt and fences a late result after Stop without claiming non-delivery", () => {
  const claimed = advanceMessage(pending(), 10000, {
    type: "CLAIM",
    now: 1000,
    attempt: "first",
  })!
  expect(claimed).toMatchObject({
    phase: "dispatching",
    revision: 1,
    attempt_id: "first",
  })
  expect(
    advanceMessage(claimed, 10000, {
      type: "CLAIM",
      now: 1001,
      attempt: "second",
    })
  ).toBeUndefined()
  const stopped = advanceMessage(claimed, 10000, {
    type: "CLOSE",
    error: "Session stopped; delivery is unconfirmed.",
  })!
  expect(stopped.phase).toBe("unconfirmed")
  expect(messageStatus(stopped)).toBe("failed")
  expect(
    advanceMessage(stopped, 10000, { type: "ACCEPTED", attempt: "first" })
  ).toBeUndefined()
})
it("only a correlated acceptance means delivered, independently of an answer", () => {
  const claimed = advanceMessage(pending(), 10000, {
    type: "CLAIM",
    now: 1000,
    attempt: "first",
  })!
  expect(
    advanceMessage(claimed, 10000, { type: "ACCEPTED", attempt: "other" })
  ).toBeUndefined()
  expect(
    advanceMessage(claimed, 10000, { type: "ACCEPTED", attempt: "first" })
  ).toMatchObject({ phase: "delivered", attempt_id: null })
})
it("keeps the existing eight-failure budget and explicit uncertain exhaustion", () => {
  let value = pending(),
    now = 1000
  for (let n = 0; n < 8; n++) {
    const attempt = `attempt-${n}`
    value = advanceMessage(value, 600000, { type: "CLAIM", now, attempt })!
    value = advanceMessage(value, 600000, { type: "RETRY", now, attempt })!
    now = value.retry_at
  }
  expect(value).toMatchObject({ phase: "unconfirmed", attempts: 7 })
  expect(value.error).toContain("eight attempts")
})
it("cold restoration retains the native identity outside machine data and rejects malformed or future state", () => {
  const claimed = advanceMessage(pending(), 10000, {
    type: "CLAIM",
    now: 1000,
    attempt: "first",
  })!
  expect(
    advanceMessage(JSON.parse(JSON.stringify(claimed)), 10000, {
      type: "RESTORE",
      now: 2000,
    })
  ).toMatchObject({
    phase: "pending",
    attempts: 0,
    retry_at: 2000,
    attempt_id: null,
  })
  expect(() =>
    advanceMessage({ ...claimed, workflow_version: 2 } as never, 10000, {
      type: "RESTORE",
      now: 2000,
    })
  ).toThrow()
  expect(() =>
    advanceMessage(claimed, 10000, { type: "ACCEPTED", attempt: 1 } as never)
  ).toThrow()
  expect(() =>
    advanceMessage(claimed, 10000, {
      type: "CLAIM",
      now: 2000,
      attempt: "x",
      ignored: true,
    } as never)
  ).toThrow()
})
