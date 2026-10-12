import { expect, it } from "vitest"
import { Effect, Schema } from "effect"
import { database } from "./database"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { AccessStore } from "../src/access/adapters/sqlite"
import { BackgroundMailbox } from "../src/delegation/adapters/background-mailbox"
import { activityEntries } from "../src/activity/sqlite"
import { activityFeed } from "../src/activity/feed"
import {
  activityPage,
  activityQuery,
  type ActivityQuery,
} from "../src/activity/contracts"
import { AgentId } from "../src/agents/domain"

const bot = { id: Schema.decodeUnknownSync(AgentId)("home"), name: "Home" }
const query: ActivityQuery = { filter: "all", cursor: null }
function fixture() {
  const db = database()
  const turns = new ConversationStore(db, {
    model: "gpt-6-luna",
    thinking: "low",
  })
  new AccessStore(db, () => [])
  new BackgroundMailbox(db, () => "active")
  return { db, turns }
}
it("paginates tied timestamps with stable domain and bot keys; new rows do not repeat earlier pages", () => {
  const { db, turns } = fixture()
  for (let n = 0; n < 85; n++) {
    const turn = turns.admit({
      operationId: crypto.randomUUID(),
      text: `Task ${n}`,
    }).turn
    turns.finish(
      turn,
      [{ id: turn.id, delivery: "answered" }],
      "Complete",
      null
    )
  }
  db.run("UPDATE chat_turns SET created_at='2026-10-11T10:00:00.000Z'")
  const first = activityPage(
    [{ entries: activityEntries(db, bot, query), issues: [] }],
    []
  )
  expect(first.entries).toHaveLength(40)
  const newTurn = turns.admit({
    operationId: crypto.randomUUID(),
    text: "Newer",
  }).turn
  db.run(
    "UPDATE chat_turns SET created_at='2026-10-11T11:00:00.000Z' WHERE id=?",
    newTurn.id
  )
  const second = activityPage(
    [
      {
        entries: activityEntries(db, bot, { ...query, cursor: first.next }),
        issues: [],
      },
    ],
    []
  )
  const third = activityPage(
    [
      {
        entries: activityEntries(db, bot, { ...query, cursor: second.next }),
        issues: [],
      },
    ],
    []
  )
  const ids = [...first.entries, ...second.entries, ...third.entries].map(
    (row) => row.key
  )
  expect(new Set(ids).size).toBe(85)
  expect(third.next).toBeNull()
  expect(ids).not.toContain(`home:turn:${newTurn.id}`)
})
it("projects receipt state without arguments, results or execution side effects", () => {
  const { db } = fixture()
  const now = Date.now()
  db.run(
    "INSERT INTO tool_operations (id,turnId,tool,input,createdAt,expiresAt,status,grantRevision,result,revision) VALUES ('tool-1','turn-1','browser_interact','PRIVATE INPUT',?,?, 'pending',0,'PRIVATE OUTPUT',0)",
    now,
    now + 60000
  )
  const readOnly = {
    ...db,
    run: () => {
      throw new Error("Activity must not write")
    },
    transaction: () => {
      throw new Error("Activity must not mutate")
    },
  }
  const entries = activityEntries(readOnly, bot, {
    ...query,
    filter: "attention",
  })
  expect(entries).toHaveLength(1)
  expect(entries[0]).toMatchObject({
    kind: "tool",
    attention: true,
    target: "conversation",
    reference: "turn-1",
  })
  expect(JSON.stringify(entries)).not.toContain("PRIVATE")
  db.run("UPDATE tool_operations SET status='done'")
  expect(
    activityEntries(readOnly, bot, { ...query, filter: "attention" })
  ).toEqual([])
})
it("shows expiry without mutating approval receipts and excludes obsolete failures after retry", () => {
  const { db, turns } = fixture()
  db.run(
    "INSERT INTO tool_operations (id,turnId,tool,input,createdAt,expiresAt,status,grantRevision,result,revision) VALUES ('expired','turn-1','browser_open','PRIVATE',0,1,'pending',0,NULL,0)"
  )
  expect(activityEntries(db, bot, query)[0]?.status).toBe("expired")
  expect(activityEntries(db, bot, { ...query, filter: "attention" })).toEqual(
    []
  )
  expect(
    db.all<{ status: string }>("SELECT status FROM tool_operations")[0]?.status
  ).toBe("pending")
  const turn = turns.admit({
    operationId: crypto.randomUUID(),
    text: "A request",
  }).turn
  turns.finish(turn, [{ id: turn.id, delivery: "unanswered" }], "", "Failed")
  expect(
    activityEntries(db, bot, { ...query, filter: "attention" })
  ).toHaveLength(1)
  turns.admit({
    operationId: crypto.randomUUID(),
    text: turn.text,
    retryOf: turn.id,
  })
  expect(activityEntries(db, bot, { ...query, filter: "attention" })).toEqual(
    []
  )
  expect(
    activityEntries(db, bot, { ...query, filter: "running" })
  ).toHaveLength(1)
})
it("reads only supplied owner-catalog bots and exposes partial failure rather than an empty success", async () => {
  const other = {
    id: Schema.decodeUnknownSync(AgentId)(crypto.randomUUID()),
    name: "Research",
  }
  const called: string[] = []
  const page = await Effect.runPromise(
    activityFeed([bot, other], query, async (agent) => {
      called.push(agent.id)
      if (agent.id === other.id) throw new Error("Unavailable")
      return { entries: [], issues: [] }
    })
  )
  expect(called).toEqual([bot.id, other.id])
  expect(page.unavailable).toEqual([other])
  expect(page.entries).toEqual([])
})
it("bounds owner-wide concurrent reads", async () => {
  let active = 0,
    max = 0
  const agents = Array.from({ length: 9 }, (_, index) => ({
    id: Schema.decodeUnknownSync(AgentId)(crypto.randomUUID()),
    name: `Bot ${index}`,
  }))
  await Effect.runPromise(
    activityFeed(agents, query, async () => {
      max = Math.max(max, ++active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      return { entries: [], issues: [] }
    })
  )
  expect(max).toBe(4)
})
it("reports an unreachable bot after the read deadline", async () => {
  const bots = Array.from({ length: 9 }, (_, index) => ({
    ...bot,
    id: Schema.decodeUnknownSync(AgentId)(crypto.randomUUID()),
    name: `Stalled ${index}`,
  }))
  let calls = 0
  const page = await Effect.runPromise(
    activityFeed(bots, query, () => {
      calls++
      return new Promise(() => {})
    })
  )
  expect(calls).toBe(4)
  expect(page.unavailable).toEqual(bots)
}, 8000)
it.each([
  "?filter=unknown",
  "?cursor=invalid",
  '?cursor={"at":"bad","key":"a"}',
])("rejects malformed query %s", (search) => {
  expect(() =>
    activityQuery(new URL(`https://local/activity${search}`))
  ).toThrow()
})

it("shows recovery and blocked states while cancellation remains authoritative", () => {
  const { db, turns } = fixture()
  const { turn } = turns.admit({
    operationId: crypto.randomUUID(),
    text: "Recover this task",
  })
  db.run(
    "UPDATE chat_turns SET status='running',recovery=? WHERE id=?",
    JSON.stringify({ view: { phase: "recovering" } }),
    turn.id
  )
  expect(activityEntries(db, bot, query)[0]).toMatchObject({
    status: "recovering",
    running: true,
  })
  db.run(
    "UPDATE chat_turns SET status='failed',recovery=? WHERE id=?",
    JSON.stringify({ view: { phase: "blocked" } }),
    turn.id
  )
  expect(
    activityEntries(db, bot, { ...query, filter: "attention" })[0]
  ).toMatchObject({ status: "blocked", attention: true, running: false })
  db.run("UPDATE chat_turns SET status='cancelled' WHERE id=?", turn.id)
  expect(activityEntries(db, bot, query)[0]).toMatchObject({
    status: "cancelled",
    attention: false,
  })
})
