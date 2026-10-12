import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { ApprovalCard } from "../src/features/access/approval-card"
import type { Approval } from "../src/access/contracts"

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
      onDecided={() => {}}
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
  it("keeps the pending decision disabled while the owning turn is stopping", () => {
    const html = render("pending", true)
    expect(html).toContain("Allow once")
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(3)
  })
  it("explains the persistent tool scope and how to revoke it", () => {
    const html = render("pending")
    expect(html).toContain("Allow once")
    expect(html).toContain("Always allow")
    expect(html).toContain("Atlas")
    expect(html).toContain("with any inputs")
    expect(html).toContain("Settings → Tool access")
    expect(html).not.toContain('disabled=""')
  })
})
