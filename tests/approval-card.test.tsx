import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import type { Approval } from "../src/access/contracts"
import { ApprovalCard } from "../src/features/access/approval-card"

function render(status: Approval["status"], disabled = false) {
  return renderToStaticMarkup(
    <ApprovalCard
      agentId="home"
      agentName="Atlas"
      toolPolicy={{
        name: "run_command",
        description: "Run a command",
        mode: "ask",
        revision: 0,
      }}
      disabled={disabled}
      approval={{
        id: "approval",
        turnId: "turn",
        tool: "run_command",
        input: "{}",
        createdAt: 0,
        expiresAt: 2000000000000,
        status,
        revision: 2,
      }}
    />
  )
}

describe("approval presentation reflects durable lifecycle", () => {
  it.each([
    "approved",
    "running",
    "done",
    "denied",
    "cancelled",
    "expired",
    "interrupted",
  ] as const)("does not offer another decision for %s actions", (status) => {
    const html = render(status)
    expect(html).not.toContain("Allow once")
    expect(html).not.toContain("Your approval is needed")
    expect(html).not.toContain("resuming")
  })
  it("never creates a second command owner in the transcript while stopping", () => {
    const html = render("pending", true)
    expect(html).toContain("Awaiting approval")
    expect(html).not.toContain("<button")
  })
  it("keeps complete inputs available in a compact read-only receipt", () => {
    const html = render("approved")
    expect(html).toContain("<details>")
    expect(html).toContain("Action inputs")
    expect(html).toContain("Approval accepted · waiting to run")
    expect(html).not.toContain("Action completed")
    expect(html).not.toContain("Allow once")
  })
})
