import { expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { Effect, Schema } from "effect"
import { database } from "./database"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { RunRecoveryStore } from "../src/conversations/adapters/sqlite-recovery"
import { AccessStore } from "../src/access/adapters/sqlite"
import { AccessGate } from "../src/access/gate"
import { usageFixture } from "./usage-fixture"
import { resolveRoute } from "../src/inference/policy"
import {
  projectRunActivity,
  RunActivity,
  type RunCursor,
} from "../src/activity/run"
import { SqliteActivityRecords } from "../src/activity/adapters/sqlite"
import {
  RunTimeline,
  RunEventView,
} from "../src/features/activity/run-timeline"
import type { Observation } from "../src/conversations/recovery"

const route = resolveRoute("conversation")
const tools = () => [
  { name: "write", description: "synthetic", mode: "ask" as const },
]
function fixture() {
  const db = database()
  const conversations = new ConversationStore(db, {
    model: route.model,
    thinking: route.thinking,
  })
  const recovery = new RunRecoveryStore(db)
  const access = new AccessStore(db, tools)
  const usage = usageFixture(db)
  const root = conversations.admit({
    operationId: crypto.randomUUID(),
    text: "Synthetic task",
  }).turn
  const read = (cursor: RunCursor | null = null) =>
    projectRunActivity(
      new SqliteActivityRecords(db).run(root.id, cursor)!,
      "bot",
      root.id,
      usage.totals(root.id),
      Date.now()
    )
  return { db, conversations, recovery, access, usage, root, read }
}
it("projects approval, model, compaction and steering records across reopen without executing work", async () => {
  const f = fixture()
  f.conversations.submitted(f.root.id, "pi-session")
  const steer = f.conversations.admit({
    operationId: crypto.randomUUID(),
    text: "Keep the constraint",
    mode: "steer",
  }).turn
  const attempt = f.usage.start(route, f.root.id, "conversation")
  attempt.usage({
    id: "provider",
    model: route.model,
    input: 100,
    cached: 80,
    output: 4,
  })
  attempt.end("completed")
  f.usage.start(route, f.root.id, "compaction").end("completed")
  f.access.begin({ id: "tool", turnId: f.root.id, tool: "write", input: "{}" })
  f.access.decide("tool", true, 0)
  const effect = vi.fn(async () => ({
    content: [{ type: "text", text: "saved" }],
  }))
  await Effect.runPromise(
    new AccessGate(f.access, () => true).run(
      { id: "tool", turnId: f.root.id, tool: "write", input: "{}" },
      Effect.tryPromise({ try: effect, catch: (cause) => cause })
    )
  )
  const reopenedAccess = new AccessStore(f.db, tools)
  const replay = await Effect.runPromise(
    new AccessGate(reopenedAccess, () => true).run(
      { id: "tool", turnId: f.root.id, tool: "write", input: "{}" },
      Effect.tryPromise({ try: effect, catch: (cause) => cause })
    )
  )
  expect(replay).toMatchObject({ content: [{ text: "saved" }] })
  expect(effect).toHaveBeenCalledOnce()
  const before = f.read()
  const tool = before.events.find((e) => e.kind === "tool")!
  expect(tool.transitions?.map((t) => t.status)).toEqual([
    "pending",
    "approved",
    "running",
    "done",
  ])
  expect(
    before.events.some((e) => e.kind === "steering" && e.reference === steer.id)
  ).toBe(true)
  expect(
    before.events.some((e) => e.title === "Working context compaction")
  ).toBe(true)
  expect(before.startedAt).not.toBeNull()
  const root = f.conversations.get(f.root.id)!
  f.conversations.finish(
    root,
    f.conversations
      .members(root.id)
      .map((t) => ({ id: t.id, delivery: "answered" })),
    "done",
    null
  )
  const reopened = new ConversationStore(f.db, {
    model: route.model,
    thinking: route.thinking,
  })
  const usage = usageFixture(f.db)
  new RunRecoveryStore(f.db)
  expect(reopened.get(root.id)?.status).toBe("done")
  const readOnly = {
    ...f.db,
    run: () => {
      throw new Error("Projection must not write")
    },
    transaction: () => {
      throw new Error("Projection must not transact")
    },
  }
  const final = projectRunActivity(
    new SqliteActivityRecords(readOnly).run(root.id, null)!,
    "bot",
    root.id,
    usage.totals(root.id),
    Date.now()
  )
  expect(final.finishedAt).not.toBeNull()
  expect(final.events.filter((e) => e.kind === "tool")).toEqual(
    before.events.filter((e) => e.kind === "tool")
  )
  expect(Schema.decodeUnknownSync(RunActivity)(final)).toEqual(final)
})
it("includes every request beyond the 100-request activity limit with stable pages and isolated totals", () => {
  const f = fixture()
  for (let i = 0; i < 121; i++)
    f.usage.start(route, f.root.id, "conversation").end("completed")
  f.usage.start(route, "different-run", "conversation").end("completed")
  const keys: string[] = []
  let page = f.read()
  for (;;) {
    keys.push(...page.events.map((e) => e.key))
    if (!page.next) break
    page = f.read(page.next)
  }
  expect(keys.filter((k) => k.startsWith("model:"))).toHaveLength(121)
  expect(new Set(keys).size).toBe(keys.length)
  expect(f.read().totals.modelRequests).toBe(121)
  expect(f.read().totals.usageReportedRequests).toBe(0)
  const other = fixture()
  expect(new SqliteActivityRecords(other.db).run(f.root.id, null)).toBeNull()
})
it("marks orphaned attempts interrupted, preserves cancellation and never invents historical timings", () => {
  const f = fixture()
  f.usage.start(route, f.root.id, "conversation")
  f.conversations.requestStop(f.root.id)
  const stopping = f.conversations.get(f.root.id)!
  f.conversations.finish(
    stopping,
    [{ id: stopping.id, delivery: "unanswered" }],
    "",
    null
  )
  usageFixture(f.db)
  const run = f.read()
  const attempt = run.events.find((e) => e.kind === "model")!
  expect(attempt.status).toBe("interrupted")
  expect(run.status).toBe("cancelled")
  expect(run.events.some((e) => e.title === "Stop requested")).toBe(true)
  expect(renderToStaticMarkup(<RunEventView event={attempt} />)).toContain(
    "Duration unknown after restart"
  )
  f.db.run(
    "UPDATE chat_turns SET started_at=NULL,finished_at=NULL,stopped_at=NULL WHERE id=?",
    f.root.id
  )
  const legacy = f.read()
  expect(
    renderToStaticMarkup(<RunTimeline run={legacy} agentId="bot" />)
  ).toContain("Not recorded")
  expect(f.conversations.active()).toBeUndefined()
})
it("retains distinct recovery transitions without double-counting replay and stop wins", () => {
  const f = fixture()
  f.conversations.submitted(f.root.id, "pi-session")
  const observation = (id: number): Observation => ({
    resultId: id,
    invocation: String(id),
    tool: "read_file",
    fingerprint: "same",
    outcome: "failure",
    receiptId: null,
  })
  for (let i = 1; i <= 3; i++)
    f.recovery.observe(f.root.id, "pi-session", "epoch", "epoch", [
      observation(i),
    ])
  const before = f.read().events.filter((e) => e.kind === "recovery")
  expect(before.length).toBeGreaterThan(0)
  new RunRecoveryStore(f.db).observe(
    f.root.id,
    "pi-session",
    "epoch",
    "epoch",
    [observation(3)]
  )
  expect(f.read().events.filter((e) => e.kind === "recovery")).toEqual(before)
  f.conversations.requestStop(f.root.id)
  f.recovery.observe(f.root.id, "pi-session", "epoch", "epoch", [
    observation(4),
  ])
  expect(f.read().events.filter((e) => e.kind === "recovery")).toEqual(before)
})
it("does not conflate failed tool results or uncertain dispatches with successful effects", () => {
  const f = fixture()
  f.access.update("write", 0, "allow")
  for (const id of ["failed", "uncertain"]) {
    f.access.begin({ id, turnId: f.root.id, tool: "write", input: "{}" })
    f.access.claim(id)
  }
  f.access.finish("failed", JSON.stringify({ isError: true, content: [] }))
  f.conversations.finish(
    f.root,
    [{ id: f.root.id, delivery: "unanswered" }],
    "",
    "failed"
  )
  const entries = f.read().events
  expect(entries.find((e) => e.reference === "failed")?.status).toBe("error")
  expect(entries.find((e) => e.reference === "uncertain")?.status).toBe(
    "unconfirmed"
  )
  expect(f.access.get("uncertain")?.status).toBe("running")
})
it("commits receipt history atomically and excludes repeated pending polls", () => {
  const f = fixture()
  f.access.begin({ id: "tool", turnId: f.root.id, tool: "write", input: "{}" })
  for (let i = 0; i < 10; i++) expect(f.access.claim("tool")).toBe("pending")
  expect(
    f.read().events.find((e) => e.kind === "tool")?.transitions
  ).toHaveLength(1)
  expect(() =>
    f.db.transaction(() => {
      f.access.decide("tool", false, 0)
      throw new Error("rollback")
    })
  ).toThrow("rollback")
  expect(f.access.get("tool")?.status).toBe("pending")
  expect(
    f.read().events.find((e) => e.kind === "tool")?.transitions
  ).toHaveLength(1)
  f.access.decide("tool", false, 0)
  expect(
    f
      .read()
      .events.find((e) => e.kind === "tool")
      ?.transitions?.map((t) => t.status)
  ).toEqual(["pending", "denied"])
})
