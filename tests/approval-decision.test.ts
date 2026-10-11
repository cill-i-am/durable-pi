import { expect, it } from "vitest"
import { approvalDecision } from "../src/features/access/decision"
import type { Approval } from "../src/access/contracts"

it("keeps confirmed decisions through old snapshots but reopens a newer approval round", () => {
  const pending: Approval = {
    id: "tool-1",
    turnId: "reply-1",
    tool: "write_note",
    input: "{}",
    createdAt: 0,
    expiresAt: 1000,
    status: "pending",
    revision: 0,
  }
  const confirmed = { revision: 0, approve: true }
  expect(approvalDecision(pending, null)).toBeNull()
  expect(approvalDecision(pending, confirmed)).toBe(true)
  expect(
    approvalDecision({ ...pending, status: "approved", revision: 1 }, confirmed)
  ).toBe(true)
  expect(approvalDecision({ ...pending, revision: 2 }, confirmed)).toBeNull()
})
