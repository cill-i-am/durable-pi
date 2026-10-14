import { describe, expect, it } from "vitest"
import {
  newestSelection,
  submissionAttempt,
} from "../src/features/conversation/commands"

describe("conversation command acknowledgement", () => {
  it("includes attachment identity in uncertain-send retries", () => {
    const id = crypto.randomUUID()
    const first = submissionAttempt(null, "", "followUp", [id])
    expect(submissionAttempt(first, "", "steer", [id])).toEqual(first)
    expect(submissionAttempt(first, "", "followUp", []).operationId).not.toBe(
      first.operationId
    )
  })
  it("retries the original intent after a lost response and a live activity transition", () => {
    const sent = submissionAttempt(null, "hello", "followUp")
    expect(submissionAttempt(sent, "hello", "steer")).toEqual(sent)
    const steer = submissionAttempt(null, "change it", "steer")
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

it("unlocks a definitively rejected model choice but retains uncertain-send intent", async () => {
  const { ApiError } = await import("../src/http/client")
  const { rejectedModelAttempt } =
    await import("../src/features/conversation/commands")
  const attempt = submissionAttempt(null, "hello", "followUp", [], "deep")
  expect(
    rejectedModelAttempt(
      new ApiError(409, "Model unavailable", "model_unavailable")
    )
  ).toBe(true)
  expect(rejectedModelAttempt(new ApiError(409, "Operation conflict"))).toBe(
    false
  )
  expect(rejectedModelAttempt(new TypeError("Network failed"))).toBe(false)
  const replacement = submissionAttempt(null, "hello", "followUp", [], "fast")
  expect(replacement.operationId).not.toBe(attempt.operationId)
  expect(replacement.profile).toBe("fast")
  expect(submissionAttempt(attempt, "hello", "followUp", [], "fast")).toEqual(
    attempt
  )
})
