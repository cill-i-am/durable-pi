import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"

import { useApproval } from "../src/features/access/use-approval"

function StartupProbe() {
  const approval = useApproval({
    agentId: "home",
    disabled: false,
    policy: {
      name: "run_command",
      description: "Run a command",
      mode: "ask",
      revision: 2,
    },
    approval: {
      id: "one",
      turnId: "turn",
      tool: "run_command",
      input: "{}",
      createdAt: 1,
      expiresAt: 9000000000000,
      status: "pending",
      revision: 4,
    },
  })
  return (
    <>
      <output>{approval.ready ? "ready" : "starting"}</output>
      <button disabled={approval.blocked(true)}>Allow once</button>
      <button disabled={approval.blocked(false)}>Deny</button>
      <button disabled={approval.blocked(true, true)}>Always allow</button>
    </>
  )
}

it("does not offer a consequential decision before the scoped approval owner exists", () => {
  // Server rendering deterministically observes the initial hook state before
  // effects can acquire the actor; every decision must be unavailable then.
  const html = renderToStaticMarkup(<StartupProbe />)
  expect(html).toContain("starting")
  expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(3)
})
