import { expect, it } from "vitest"

import type { Approval } from "../src/access/contracts"
import { approvalDecision } from "../src/features/access/decision"

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
  const confirmed = { approval: pending, revision: 0, approve: true }
  expect(approvalDecision(pending, null)).toBeNull()
  expect(approvalDecision(pending, confirmed)).toBe(true)
  expect(
    approvalDecision({ ...pending, status: "approved", revision: 1 }, confirmed)
  ).toBe(true)
  expect(approvalDecision({ ...pending, revision: 2 }, confirmed)).toBeNull()
})

it("does not carry a confirmation to another action or changed immutable inputs", () => {
  const approval: Approval = {
    id: "one",
    turnId: "turn",
    tool: "write_note",
    input: "old",
    createdAt: 1,
    expiresAt: 1000,
    revision: 0,
    status: "pending",
  }
  const confirmed = { approval, revision: 0, approve: true }
  expect(approvalDecision({ ...approval, id: "two" }, confirmed)).toBeNull()
  expect(approvalDecision({ ...approval, input: "new" }, confirmed)).toBeNull()
})
