import { useState } from "react"
import { createRoot } from "react-dom/client"

import type { RunActivity } from "../../../src/activity/run"
import { homeAgentId } from "../../../src/agents/domain"
import { ActivityWorkbench } from "../../../src/features/activity/activity-workbench"
import { RunTimeline } from "../../../src/features/activity/run-timeline"
import { usePlans } from "../../../src/features/activity/use-plans"

const proof = { calls: [] as string[], aborted: 0, release: () => {} }
Object.assign(window, { proof })
const mode = new URLSearchParams(location.search).get("mode")
const selected = "11111111-1111-4111-8111-111111111111"
const wrongPlan = {
  plan: {
    id: "22222222-2222-4222-8222-222222222222",
    schemaVersion: 1,
    revision: 1,
    objective: "Wrong plan",
    constraints: [],
    criteria: ["review"],
    steps: [
      {
        id: "review",
        title: "Review",
        status: "pending",
        evidence: [],
        note: "",
      },
    ],
    complete: false,
    state: "open",
    nextAction: "review",
    blocker: "",
    rootTurns: [],
    inputIds: [],
    reviewedTurn: selected,
    inputRevision: 0,
    createdAt: "2026-10-23",
    updatedAt: "2026-10-23",
  },
  history: [],
  nextHistory: null,
}

const run = (id: string, older = false): RunActivity => ({
  botId: "bot",
  runId: id,
  sessionId: null,
  status: "done",
  createdAt: "2026-10-23T00:00:00Z",
  startedAt: null,
  finishedAt: null,
  totals: {
    modelRequests: 0,
    usageReportedRequests: 0,
    knownInputTokens: 0,
    knownCachedInputTokens: 0,
    knownOutputTokens: 0,
  },
  events: [
    {
      key: id,
      at: "2026-10-23T00:00:00Z",
      kind: "run",
      title: `${id} ${older ? "older" : "latest"}`,
      status: "done",
      reference: id,
      finishedAt: null,
      detail: null,
    },
  ],
  next: older ? null : { at: "2026-10-23T00:00:00Z", key: id },
})
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.href)
  proof.calls.push(url.pathname)
  init?.signal?.addEventListener("abort", () => proof.aborted++)
  if (url.pathname.endsWith("/access"))
    return Response.json({ tools: [], approvals: [] })
  if (mode === "identity")
    return Response.json(
      url.pathname.endsWith("/plans")
        ? { plans: [], nextOffset: null }
        : wrongPlan
    )
  if (mode === "history" || mode === "initial-history") {
    if (url.pathname.endsWith("/plans"))
      return Response.json({ plans: [], nextOffset: null })
    const plan = {
      ...wrongPlan.plan,
      id: selected,
      objective: "Selected plan",
      revision: 3,
    }
    const foreign = {
      plan: wrongPlan.plan,
      actor: "agent",
      reason: "Foreign history marker",
      turnId: null,
    }
    const history =
      url.searchParams.has("before") || mode === "initial-history"
        ? [foreign]
        : [3, 2].map((revision) => ({
            plan: { ...plan, revision },
            actor: "agent",
            reason: "Selected history",
            turnId: null,
          }))
    return Response.json({ plan, history, nextHistory: 2 })
  }
  return await new Promise<Response>((resolve) => {
    proof.release = () =>
      resolve(
        Response.json(
          url.pathname.endsWith("/plans")
            ? { plans: [], nextOffset: null }
            : {
                source: "user",
                id: "old",
                text: "",
                answer: "",
                status: "done",
                error: null,
                activity: [],
                run: run("old", true),
              }
        )
      )
  })
}
function Plans() {
  const [mounted, setMounted] = useState(true)
  return (
    <>
      <button onClick={() => setMounted(false)}>Unmount query</button>
      {mounted && <PlanQuery />}
    </>
  )
}
function PlanQuery() {
  const state = usePlans(
    "bot",
    mode === "identity" || mode === "initial-history" ? selected : null,
    0
  )
  return (
    <>
      <output>{state.loading ? "loading" : "loaded"}</output>
      <p data-detail>{state.detail?.plan.id ?? "none"}</p>
      <p data-error>{state.error}</p>
      <button onClick={() => void state.refresh()}>Refresh plans</button>
    </>
  )
}
function Runs() {
  const [id, setId] = useState("old")
  return (
    <>
      <button onClick={() => setId("new")}>Switch run</button>
      <RunTimeline run={run(id)} agentId="bot" />
    </>
  )
}
function History() {
  return (
    <ActivityWorkbench
      agentId={homeAgentId}
      agentName="Home"
      agents={[{ id: homeAgentId, name: "Home" }]}
      onOpenBot={() => {}}
      onMemory={() => {}}
      view="tasks"
      inspectedAgentId={homeAgentId}
      selected={selected}
      onSelectionChange={() => {}}
      filters={{}}
      onFiltersChange={() => {}}
      offset={0}
      onOffsetChange={() => {}}
    />
  )
}
createRoot(document.getElementById("root")!).render(
  mode === "run" ? <Runs /> : mode === "history" ? <History /> : <Plans />
)
