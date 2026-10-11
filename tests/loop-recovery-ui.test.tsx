import { expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { RecoveryNotice } from "../src/features/activity/activity-record"
import {
  recoveryDetail,
  type RecoveryView,
} from "../src/conversations/recovery"

const recovery: RecoveryView = {
  phase: "recovering",
  reason: "repetition",
  tool: "read_file",
  failures: 3,
  remaining: 3,
  resultId: 42,
  receiptId: "receipt-1",
  detail: "",
}
it("distinguishes recovery, progress and blockers with references to saved evidence", () => {
  for (const [phase, title] of [
    ["recovering", "Trying to recover"],
    ["recovered", "Tool recovery made progress"],
    ["blocked", "Work needs attention"],
  ] as const) {
    const view = { ...recovery, phase }
    const html = renderToStaticMarkup(
      <RecoveryNotice
        recovery={{ ...view, detail: recoveryDetail(view) }}
        status={phase === "blocked" ? "failed" : "running"}
      />
    )
    expect(html).toContain(title)
    expect(html).toContain("Saved result 42")
    expect(html).toContain("Receipt receipt-1")
    expect(html).not.toContain("Retry automatically")
  }
})
it("cancellation overrides stored recovery instructions", () => {
  expect(
    renderToStaticMarkup(
      <RecoveryNotice recovery={recovery} status="cancelled" />
    )
  ).toBe("")
  expect(
    renderToStaticMarkup(
      <RecoveryNotice recovery={recovery} status="stopping" />
    )
  ).toBe("")
})

it("does not promise further attempts after a reply has ended", () => {
  const html = renderToStaticMarkup(
    <RecoveryNotice recovery={recovery} status="done" />
  )
  expect(html).toContain("Reply ended with tool failures")
  expect(html).not.toContain("attempts left")
})
