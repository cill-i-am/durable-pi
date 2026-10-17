import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"

import { PlanView } from "../src/features/activity/activity-workbench"
import { historyPage } from "../src/features/activity/history"
import type { Plan, PlanRevision } from "../src/planning/contracts"

const plan: Plan = {
  id: crypto.randomUUID(),
  schemaVersion: 1,
  revision: 1,
  objective: "Prepare the guide",
  constraints: ["Do not publish"],
  criteria: ["Guide reviewed"],
  steps: [
    {
      id: "guide",
      title: "Review guide",
      status: "completed",
      evidence: [],
      note: "Reviewed by the agent",
    },
  ],
  complete: true,
  state: "completed",
  nextAction: "",
  blocker: "",
  rootTurns: [],
  inputIds: [],
  reviewedTurn: crypto.randomUUID(),
  inputRevision: 0,
  createdAt: "2026-10-11",
  updatedAt: "2026-10-11",
}
const page = (top: number, bottom: number): PlanRevision[] =>
  Array.from({ length: top - bottom + 1 }, (_, i) => ({
    plan: { ...plan, revision: top - i },
    actor: "agent",
    reason: "Updated",
    turnId: null,
  }))
it("keeps earlier revisions reachable when polling advances the latest page or skips loaded pages", () => {
  expect(historyPage(page(9, 1), []).cursor).toBeNull()
  expect(historyPage(page(12, 3), []).cursor).toBe(3)
  expect(historyPage(page(25, 16), page(12, 1)).cursor).toBe(16)
  const filled = historyPage(page(25, 16), [...page(15, 6), ...page(12, 1)])
  expect(filled.cursor).toBeNull()
  expect(filled.history).toHaveLength(25)
})
it("distinguishes agent completion from source validation and displays cancellation without a next action", () => {
  const html = renderToStaticMarkup(<PlanView plan={plan} />)
  expect(html).toContain("Reported complete")
  expect(html).toContain("Agent-reported completion")
  expect(html).not.toContain("Verified complete")
  const stopped = renderToStaticMarkup(
    <PlanView
      plan={{
        ...plan,
        state: "cancelled",
        blocker: "Stopped by you",
        nextAction: "Do not show",
      }}
    />
  )
  expect(stopped).toContain("Work stopped")
  expect(stopped).not.toContain("Do not show")
  expect(stopped).not.toContain('data-status="running"')
})
