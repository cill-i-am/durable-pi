import { describe, expect, it } from "vitest"
import {
  newestSelection,
  submissionAttempt,
} from "../src/features/conversation/commands"

describe("conversation command acknowledgement", () => {
  it("retries the original intent after a lost response and a live activity transition", () => {
    const sent = submissionAttempt(null, "hello", "followUp")
    // SSE becomes active before HTTP delivery is known; do not send a duplicate steer.
    expect(submissionAttempt(sent, "hello", "steer")).toEqual(sent)
    const steer = submissionAttempt(null, "change it", "steer")
    // The same uncertain steer remains the same operation after the reply finishes.
    expect(submissionAttempt(steer, "change it", "followUp")).toEqual(steer)
    expect(
      submissionAttempt(sent, "different message", "steer").operationId
    ).not.toBe(sent.operationId)
  })
  it("keeps the confirmed model while SSE is delayed, then accepts newer remote settings", () => {
    const old = { model: "a", thinking: "low" as const, settingsRevision: 1 }
    const saved = { model: "b", thinking: "high" as const, settingsRevision: 2 }
    expect(newestSelection(old, saved).model).toBe("b")
    const remote = { ...old, settingsRevision: 3 }
    expect(newestSelection(remote, saved)).toEqual(remote)
  })
})
