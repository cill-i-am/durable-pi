import { Clock, Effect, Schema } from "effect"
import { expect, it } from "vitest"

import { toolOperations } from "../src/access/adapters/schema"
import { AccessStore } from "../src/access/adapters/sqlite"
import { activityQuery } from "../src/activity/adapters/http"
import { activityEntries } from "../src/activity/adapters/sqlite-entries"
import { activityPage, type ActivityQuery } from "../src/activity/contracts"
import { activityFeed } from "../src/activity/feed"
import { ActivityUnavailable } from "../src/activity/records"
import { AgentId } from "../src/agents/domain"
import { chatTurns } from "../src/conversations/adapters/schema"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { SqliteBackgroundMailbox } from "../src/delegation/adapters/background-mailbox"
import { backgroundHandoffs } from "../src/delegation/adapters/schema"
import { database } from "./database"

const bot = { id: Schema.decodeUnknownSync(AgentId)("home"), name: "Home" }
const query: ActivityQuery = { filter: "all", cursor: null }
function fixture() {
  const db = database()
  const turns = new ConversationStore(db, {
    model: "gpt-6-luna",
    thinking: "low",
  })
  new AccessStore(db, () => Effect.succeed([]))
  new SqliteBackgroundMailbox(db)
  return { db, turns }
}
it("paginates tied timestamps with stable domain and bot keys; new rows do not repeat earlier pages", () => {
  const { db, turns } = fixture()
  for (let n = 0; n < 85; n++) {
    const turn = Effect.runSync(
      turns.admit(
        {
          operationId: crypto.randomUUID(),
          text: `Task ${n}`,
        },
        undefined,
        undefined,
        undefined,
        { discoveryDeadline: Effect.runSync(Clock.currentTimeMillis) + 60_000 }
      )
    ).turn
    Effect.runSync(
      turns.finish(
        turn,
        [{ id: turn.id, delivery: "answered" }],
        "Complete",
        null
      )
    )
  }
  db.run("UPDATE chat_turns SET created_at='2026-10-11T10:00:00.000Z'")
  const first = activityPage(
    [
      {
        entries: Effect.runSync(activityEntries(db, bot, query, Date.now())),
        issues: [],
      },
    ],
    []
  )
  expect(first.entries).toHaveLength(40)
  const newTurn = Effect.runSync(
    turns.admit(
      {
        operationId: crypto.randomUUID(),
        text: "Newer",
      },
      undefined,
      undefined,
      undefined,
      { discoveryDeadline: Effect.runSync(Clock.currentTimeMillis) + 60_000 }
    )
  ).turn
  db.run(
    "UPDATE chat_turns SET created_at='2026-10-11T11:00:00.000Z' WHERE id=?",
    newTurn.id
  )
  const second = activityPage(
    [
      {
        entries: Effect.runSync(
          activityEntries(db, bot, { ...query, cursor: first.next }, Date.now())
        ),
        issues: [],
      },
    ],
    []
  )
  const third = activityPage(
    [
      {
        entries: Effect.runSync(
          activityEntries(
            db,
            bot,
            { ...query, cursor: second.next },
            Date.now()
          )
        ),
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
  const entries = Effect.runSync(
    activityEntries(
      readOnly,
      bot,
      {
        ...query,
        filter: "attention",
      },
      Date.now()
    )
  )
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
    Effect.runSync(
      activityEntries(
        readOnly,
        bot,
        { ...query, filter: "attention" },
        Date.now()
      )
    )
  ).toEqual([])
})
it("shows expiry without mutating approval receipts and excludes obsolete failures after retry", () => {
  const { db, turns } = fixture()
  db.run(
    "INSERT INTO tool_operations (id,turnId,tool,input,createdAt,expiresAt,status,grantRevision,result,revision) VALUES ('expired','turn-1','browser_open','PRIVATE',0,1,'pending',0,NULL,0)"
  )
  expect(
    Effect.runSync(activityEntries(db, bot, query, Date.now()))[0]?.status
  ).toBe("expired")
  expect(
    Effect.runSync(
      activityEntries(db, bot, { ...query, filter: "attention" }, Date.now())
    )
  ).toEqual([])
  expect(
    db.all<{ status: string }>("SELECT status FROM tool_operations")[0]?.status
  ).toBe("pending")
  const turn = Effect.runSync(
    turns.admit(
      {
        operationId: crypto.randomUUID(),
        text: "A request",
      },
      undefined,
      undefined,
      undefined,
      { discoveryDeadline: Effect.runSync(Clock.currentTimeMillis) + 60_000 }
    )
  ).turn
  Effect.runSync(
    turns.finish(turn, [{ id: turn.id, delivery: "unanswered" }], "", "Failed")
  )
  expect(
    Effect.runSync(
      activityEntries(db, bot, { ...query, filter: "attention" }, Date.now())
    )
  ).toHaveLength(1)
  Effect.runSync(
    turns.admit(
      {
        operationId: crypto.randomUUID(),
        text: turn.text,
        retryOf: turn.id,
      },
      undefined,
      undefined,
      undefined,
      { discoveryDeadline: Effect.runSync(Clock.currentTimeMillis) + 60_000 }
    )
  )
  expect(
    Effect.runSync(
      activityEntries(db, bot, { ...query, filter: "attention" }, Date.now())
    )
  ).toEqual([])
  expect(
    Effect.runSync(
      activityEntries(db, bot, { ...query, filter: "running" }, Date.now())
    )
  ).toHaveLength(1)
})
it("reads only supplied owner-catalog bots and exposes partial failure rather than an empty success", async () => {
  const other = {
    id: Schema.decodeUnknownSync(AgentId)(crypto.randomUUID()),
    name: "Research",
  }
  const called: string[] = []
  const page = await Effect.runPromise(
    activityFeed([bot, other], query, (agent) =>
      Effect.suspend(() => {
        called.push(agent.id)
        if (agent.id === other.id)
          return Effect.fail(new ActivityUnavailable({ cause: "Unavailable" }))
        return Effect.succeed({ entries: [], issues: [] })
      })
    )
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
    activityFeed(agents, query, () =>
      Effect.promise(async () => {
        max = Math.max(max, ++active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active--
        return { entries: [], issues: [] }
      })
    )
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
    activityFeed(bots, query, () =>
      Effect.suspend(() => {
        calls++
        return Effect.never
      })
    )
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
  const { turn } = Effect.runSync(
    turns.admit(
      {
        operationId: crypto.randomUUID(),
        text: "Recover this task",
      },
      undefined,
      undefined,
      undefined,
      { discoveryDeadline: Effect.runSync(Clock.currentTimeMillis) + 60_000 }
    )
  )
  db.run(
    "UPDATE chat_turns SET status='running',recovery=? WHERE id=?",
    JSON.stringify({ view: { phase: "recovering" } }),
    turn.id
  )
  expect(
    Effect.runSync(activityEntries(db, bot, query, Date.now()))[0]
  ).toMatchObject({
    status: "recovering",
    running: true,
  })
  db.run(
    "UPDATE chat_turns SET status='failed',recovery=? WHERE id=?",
    JSON.stringify({ view: { phase: "blocked" } }),
    turn.id
  )
  expect(
    Effect.runSync(
      activityEntries(db, bot, { ...query, filter: "attention" }, Date.now())
    )[0]
  ).toMatchObject({ status: "blocked", attention: true, running: false })
  db.run("UPDATE chat_turns SET status='cancelled' WHERE id=?", turn.id)
  expect(
    Effect.runSync(activityEntries(db, bot, query, Date.now()))[0]
  ).toMatchObject({
    status: "cancelled",
    attention: false,
  })
})

it("keeps mixed sources in one globally bounded page when timestamps tie", () => {
  const db = database()
  const at = "2026-10-16T12:00:00.000Z"
  const now = new Date(at).getTime()
  const turns = Array.from({ length: 20 }, (_, index) => ({
    id: `request-${String(index).padStart(2, "0")}`,
    text: "😀".repeat(190),
    status: "failed",
    created_at: at,
  }))
  const tools = Array.from({ length: 20 }, (_, index) => ({
    id: `receipt-${String(index).padStart(2, "0")}`,
    turnId: "run",
    tool: "write",
    input: "PRIVATE INPUT",
    createdAt: now,
    expiresAt: now + 60_000,
    status: "pending",
    grantRevision: 0,
  }))
  const background = Array.from({ length: 20 }, (_, index) => ({
    id: index + 1,
    turn_id: `background-${index}`,
    handoff: JSON.stringify({
      createdAt: now,
      input: { objective: "Background task" },
    }),
    status: "paused",
  }))
  Effect.runSync(db.use((orm) => orm.insert(chatTurns).values(turns)))
  Effect.runSync(db.use((orm) => orm.insert(toolOperations).values(tools)))
  Effect.runSync(
    db.use((orm) => orm.insert(backgroundHandoffs).values(background))
  )
  const read = (cursor: ActivityQuery["cursor"]) =>
    Effect.runSync(
      activityEntries(db, bot, { filter: "attention", cursor }, now)
    )
  const candidates = read(null)
  expect(candidates).toHaveLength(41)
  const first = activityPage([{ entries: candidates, issues: [] }], [])
  const second = activityPage([{ entries: read(first.next), issues: [] }], [])
  const expected = [
    ...turns.map((turn) => `home:turn:${turn.id}`),
    ...tools.map((tool) => `home:tool:${tool.id}`),
    ...background.map((task) => `home:background:${task.id}`),
  ]
    .sort()
    .reverse()
  expect(
    [...first.entries, ...second.entries].map((entry) => entry.key)
  ).toEqual(expected)
  expect(first.entries).toHaveLength(40)
  expect(second.entries).toHaveLength(20)
  expect(second.next).toBeNull()
  expect(
    first.entries.find((entry) => entry.kind === "conversation")?.title
  ).toBe("😀".repeat(180))
  expect(
    Effect.runSync(
      activityEntries(db, bot, { filter: "running", cursor: null }, now)
    )
  ).toEqual([])
  expect(JSON.stringify(candidates)).not.toContain("PRIVATE INPUT")
})

it("keeps unconfirmed background cleanup in attention and pending cleanup in active records", () => {
  const { db } = fixture()
  Effect.runSync(
    db.use((orm) =>
      orm.insert(backgroundHandoffs).values(
        (["pending", "unconfirmed", "confirmed"] as const).map(
          (stop_state, index) => ({
            id: index + 1,
            turn_id: `stopped-${index}`,
            status: "cancelled",
            stop_state,
            handoff: JSON.stringify({
              createdAt: Date.now(),
              input: { objective: "Stopped task" },
            }),
          })
        )
      )
    )
  )
  const all = Effect.runSync(activityEntries(db, bot, query, Date.now()))
  expect(all.find((entry) => entry.reference === "1")).toMatchObject({
    status: "stopping",
    running: true,
    attention: false,
  })
  expect(all.find((entry) => entry.reference === "2")).toMatchObject({
    status: "stop-unconfirmed",
    running: false,
    attention: true,
  })
  expect(all.find((entry) => entry.reference === "3")).toMatchObject({
    status: "cancelled",
    running: false,
    attention: false,
  })
  expect(
    Effect.runSync(
      activityEntries(db, bot, { ...query, filter: "attention" }, Date.now())
    ).map((entry) => entry.reference)
  ).toEqual(["2"])
})
