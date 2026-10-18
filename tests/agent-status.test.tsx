import { Effect, Schema } from "effect"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { AccessStore } from "../src/access/adapters/sqlite"
import { agentRuntimeReader } from "../src/agents/adapters/statuses"
import {
  homeAgentId,
  AgentId,
  type AgentProfile,
} from "../src/agents/contracts"
import { agentStatuses } from "../src/agents/statuses"
import {
  AgentStatus,
  AgentStatusMarker,
  agentStatusLabel,
} from "../src/components/agent-status"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import {
  runtimeStatus,
  RuntimeStatus,
  type StatusTurn,
} from "../src/conversations/status"
import { database } from "./database"

const idle = { archived: false, needsApproval: false, planBlocked: false }
const turn = (status: StatusTurn["status"], id = "root"): StatusTurn => ({
  id,
  status,
})

describe("agent runtime status", () => {
  it("retains latest failed and blocked outcomes; ordinary tool errors and past failures cannot taint a new run", () => {
    expect(runtimeStatus({ ...idle, latest: turn("failed") }).state).toBe(
      "failed"
    )
    expect(
      runtimeStatus({
        ...idle,
        latest: { ...turn("failed"), recovery: { phase: "blocked" } },
      }).state
    ).toBe("blocked")
    expect(
      runtimeStatus({ ...idle, latest: turn("done"), planBlocked: true }).state
    ).toBe("blocked")
    for (const status of ["queued", "preparing", "running"] as const) {
      expect(
        runtimeStatus({
          ...idle,
          latest: turn("failed"),
          active: turn(status, "new"),
          planBlocked: true,
        })
      ).toEqual({ state: "working", turnId: "new" })
    }
    expect(runtimeStatus({ ...idle, latest: turn("done") }).state).toBe("ready")
  })
  it("prioritizes cancellation, durable blocking, approval waits and archive without granting permission", () => {
    const blocked = {
      ...turn("running"),
      recovery: { phase: "blocked" as const },
    }
    expect(
      runtimeStatus({ ...idle, active: blocked, needsApproval: true }).state
    ).toBe("blocked")
    expect(
      runtimeStatus({ ...idle, active: turn("running"), needsApproval: true })
        .state
    ).toBe("needs-approval")
    expect(
      runtimeStatus({
        ...idle,
        active: { ...blocked, status: "stopping" },
        needsApproval: true,
      }).state
    ).toBe("stopping")
    expect(
      runtimeStatus({
        ...idle,
        latest: { ...blocked, status: "cancelled" },
        planBlocked: true,
      }).state
    ).toBe("ready")
    expect(
      runtimeStatus({ ...idle, active: blocked, archived: true }).state
    ).toBe("archived")
    expect(runtimeStatus(idle).state).toBe("ready")
  })
  it("reads root-run facts through reload without steering, transcripts, or tool arguments entering the projection", () => {
    const db = database(),
      defaults = { model: "test", thinking: "medium" as const }
    let store = new ConversationStore(db, defaults)
    const root = crypto.randomUUID(),
      steer = crypto.randomUUID()
    db.run(
      "INSERT INTO chat_turns(id,text,status,created_at,recovery) VALUES (?,?,?,?,?)",
      root,
      "private request",
      "failed",
      "today",
      JSON.stringify({ view: { phase: "blocked" }, sensitive: "tool output" })
    )
    db.run(
      "INSERT INTO chat_turns(id,text,status,created_at,parent_id) VALUES (?,?,?,?,?)",
      steer,
      "private steering",
      "done",
      "today",
      root
    )
    const before = db.all("SELECT * FROM chat_turns")
    store = new ConversationStore(db, defaults)
    expect(Effect.runSync(store.statusTurns())).toEqual({
      active: undefined,
      latest: { id: root, status: "failed", recovery: { phase: "blocked" } },
    })
    expect(db.all("SELECT * FROM chat_turns")).toEqual(before)
    expect(JSON.stringify(Effect.runSync(store.statusTurns()))).not.toMatch(
      /private|tool output/
    )
    expect(
      Effect.runSync(new ConversationStore(database(), defaults).statusTurns())
        .latest
    ).toBeUndefined()
  })
  it("checks only the current turn's unexpired pending approval without mutating receipts", () => {
    const db = database()
    let now = 100
    const store = new AccessStore(
      db,
      () =>
        Effect.sync(() => [{ name: "test", description: "test", mode: "ask" }]),
      () => now
    )
    const intent = {
      id: "approval",
      turnId: "root",
      tool: "test",
      input: "private",
    }
    Effect.runSync(store.begin(intent))
    expect(Effect.runSync(store.awaitingApproval("other"))).toBe(false)
    expect(Effect.runSync(store.awaitingApproval("root"))).toBe(true)
    Effect.runSync(store.decide(intent.id, true, 0))
    expect(Effect.runSync(store.awaitingApproval("root"))).toBe(false)
    const other = { ...intent, id: "expired" }
    Effect.runSync(store.begin(other))
    const before = db.all("SELECT * FROM tool_operations")
    now = Number.MAX_SAFE_INTEGER
    expect(Effect.runSync(store.awaitingApproval("root"))).toBe(false)
    expect(db.all("SELECT * FROM tool_operations")).toEqual(before)
  })
  it("isolates owner-catalog projections and marks unreadable bots unavailable rather than Ready", async () => {
    const profile = (
      id: AgentProfile["id"],
      status: AgentProfile["status"] = "active"
    ): AgentProfile => ({
      id,
      slug: id,
      status,
      name: id,
      instructions: "",
      revision: 0,
      createdAt: "today",
      updatedAt: "today",
    })
    const unreadable = Schema.decodeUnknownSync(AgentId)(crypto.randomUUID())
    const archived = Schema.decodeUnknownSync(AgentId)(crypto.randomUUID())
    const agents = [
      profile(homeAgentId),
      profile(unreadable),
      profile(archived, "archived"),
    ]
    const seen: string[] = []
    const result = await Effect.runPromise(
      agentStatuses(
        agents,
        agentRuntimeReader(
          async (agent) => {
            seen.push(agent.id)
            if (agent.id === unreadable)
              throw new Error("private infrastructure error")
            return { state: "failed", turnId: "saved-root" }
          },
          () => {}
        )
      )
    )
    expect(seen).toEqual([homeAgentId, unreadable])
    expect(result.statuses).toEqual([
      { agentId: homeAgentId, state: "failed", turnId: "saved-root" },
      { agentId: unreadable, state: "unavailable", turnId: null },
      { agentId: archived, state: "archived", turnId: null },
    ])
    expect(JSON.stringify(result)).not.toContain("private")
  })
  it("keeps every state readable while ready avatars remain quiet", () => {
    for (const state of [
      "ready",
      "working",
      "needs-approval",
      "stopping",
      "blocked",
      "failed",
      "archived",
      "unavailable",
    ] as const) {
      const html = renderToStaticMarkup(
        <AgentStatus
          status={
            Schema.decodeUnknownSync(RuntimeStatus)({ state, turnId: null })
              .state
          }
        />
      )
      expect(html).toContain(`data-agent-status="${state}"`)
      expect(html).toContain('aria-hidden="true"')
      expect(html).toContain(
        state === "needs-approval"
          ? "Needs approval"
          : state[0]!.toUpperCase() + state.slice(1)
      )
      expect(html).toContain(agentStatusLabel(state))
      const marker = renderToStaticMarkup(<AgentStatusMarker status={state} />)
      if (state === "ready") expect(marker).toBe("")
      else {
        expect(marker).toContain(`data-agent-status="${state}"`)
        expect(marker).toContain('aria-hidden="true"')
      }
    }
    expect(agentStatusLabel(undefined)).toBe("Unavailable")
    expect(
      renderToStaticMarkup(<AgentStatusMarker status={undefined} />)
    ).toContain('data-agent-status="unavailable"')
  })
})
