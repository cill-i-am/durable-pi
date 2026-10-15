import { expect, it } from "@effect/vitest"
import { it as test } from "vitest"
import { Cause, Effect, Exit, Fiber, Schema } from "effect"
import { TestClock } from "effect/testing"
import { database } from "./database"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { sqliteConversationMaterialization } from "../src/conversations/adapters/sqlite-journal"
import { RunRecoveryStore } from "../src/conversations/adapters/sqlite-recovery"
import { AccessStore } from "../src/access/adapters/sqlite"
import { SqliteBackgroundMailbox } from "../src/delegation/adapters/background-mailbox"
import { usageFixture } from "./usage-fixture"
import { SqliteActivityRecords } from "../src/activity/adapters/sqlite"
import { makeActivity, type ActivitySources } from "../src/activity/service"
import { activityFeed } from "../src/activity/feed"
import { ActivitySnapshot, type ActivityAgent } from "../src/activity/contracts"
import { ActivityUnavailable } from "../src/activity/records"
import {
  activityDirectory,
  activityRpc,
  type ActivityAgentRpc,
} from "../src/activity/adapters/rpc"
import { activityRequest } from "../src/activity/adapters/http"
import type { ActivityDirectory } from "../src/activity/reader"
import { homeAgentId, AgentId, agentObjectName } from "../src/agents/domain"

const bot = { id: homeAgentId, name: "Home" }
const query = { filter: "all" as const, cursor: null }
const totals = {
  modelRequests: 0,
  usageReportedRequests: 0,
  knownInputTokens: 0,
  knownCachedInputTokens: 0,
  knownOutputTokens: 0,
}
function gate<T>() {
  let release!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
function fixture(overrides: Partial<ActivitySources> = {}) {
  const db = database(),
    conversations = new ConversationStore(db, {
      model: "gpt-6-luna",
      thinking: "low",
    })
  sqliteConversationMaterialization(db)
  new RunRecoveryStore(db)
  new AccessStore(db, () => [])
  new SqliteBackgroundMailbox(db)
  const usage = usageFixture(db)
  const sources: ActivitySources = {
    profiles: () => Effect.succeed([]),
    pausedSummaries: () => Effect.succeed(0),
    backupError: () => Effect.succeed(null),
    totals: (id) => Effect.sync(() => usage.totals(id)),
    ...overrides,
  }
  const readOnly = {
    ...db,
    run: () => {
      throw new Error("Activity cannot write")
    },
    transaction: () => {
      throw new Error("Activity cannot transact")
    },
  }
  const records = new SqliteActivityRecords(readOnly)
  return {
    db,
    conversations,
    records,
    sources,
    app: makeActivity(records, sources, "native-bot"),
  }
}
const unavailable = () =>
  new ActivityUnavailable({ cause: "Private native details" })

it.effect(
  "projects tool expiry from invocation Clock without changing its durable receipt",
  () =>
    Effect.gen(function* () {
      const f = fixture(),
        turn = f.conversations.admit({
          operationId: crypto.randomUUID(),
          text: "Request",
        }).turn
      f.db.run(
        "INSERT INTO tool_operations (id,turnId,tool,input,createdAt,expiresAt,status,grantRevision,result,revision) VALUES ('tool',?,'write','PRIVATE INPUT',0,1000,'pending',0,'PRIVATE OUTPUT',0)",
        turn.id
      )
      expect(
        (yield* f.app.snapshot(bot, query)).entries.find(
          (entry) => entry.kind === "tool"
        )?.status
      ).toBe("pending")
      yield* TestClock.adjust(1000)
      const snapshot = yield* f.app.snapshot(bot, query)
      expect(
        snapshot.entries.find((entry) => entry.kind === "tool")
      ).toMatchObject({ status: "expired", attention: false })
      expect(
        (yield* f.app.conversation(turn.id))?.run?.events.find(
          (event) => event.kind === "tool"
        )?.status
      ).toBe("expired")
      expect(
        f.db.all<{ status: string }>("SELECT status FROM tool_operations")[0]!
          .status
      ).toBe("pending")
      expect(JSON.stringify(snapshot)).not.toContain("PRIVATE")
    })
)

it.effect(
  "reads a steering record through its root without exposing private prompt or changing work",
  () =>
    Effect.gen(function* () {
      const f = fixture(),
        root = f.conversations.admit({
          operationId: crypto.randomUUID(),
          text: "Root",
        }).turn
      f.conversations.submitted(root.id, "session")
      const steer = f.conversations.admit({
        operationId: crypto.randomUUID(),
        text: "Later constraint",
        mode: "steer",
      }).turn
      f.db.run(
        "UPDATE chat_turns SET prompt='PRIVATE PROMPT' WHERE id=?",
        root.id
      )
      f.db.run(
        "INSERT INTO chat_activity VALUES (?,?)",
        steer.id,
        JSON.stringify([{ id: "text", type: "text", text: "Recorded trace" }])
      )
      const before = f.db.all("SELECT id,status,session_id FROM chat_turns")
      const record = yield* f.app.conversation(steer.id)
      expect(record).toMatchObject({
        id: steer.id,
        text: "Later constraint",
        source: "user",
        run: { runId: root.id, sessionId: "session", totals },
      })
      expect(record?.activity).toEqual([
        { id: "text", type: "text", text: "Recorded trace" },
      ])
      expect(JSON.stringify(record)).not.toContain("PRIVATE PROMPT")
      expect(f.db.all("SELECT id,status,session_id FROM chat_turns")).toEqual(
        before
      )
    })
)

it.effect(
  "only shows account-independent issues on the first relevant page",
  () =>
    Effect.gen(function* () {
      let reads = 0
      const f = fixture({
        pausedSummaries: () =>
          Effect.sync(() => {
            reads++
            return 2
          }),
        backupError: () =>
          Effect.sync(() => {
            reads++
            return "Private backup reason"
          }),
      })
      const first = yield* f.app.snapshot(bot, query)
      expect(first.issues.map((issue) => issue.key)).toEqual([
        "home:memory",
        "home:backup",
      ])
      expect(JSON.stringify(first)).not.toContain("Private backup")
      expect(
        (yield* f.app.snapshot(bot, { filter: "running", cursor: null })).issues
      ).toEqual([])
      expect(
        (yield* f.app.snapshot(bot, {
          filter: "all",
          cursor: { at: "2026-10-01T00:00:00.000Z", key: "home:turn:a" },
        })).issues
      ).toEqual([])
      expect(reads).toBe(2)
    })
)

it.effect(
  "turns driver read failures into finite errors while corrupt selected records stay defects",
  () =>
    Effect.gen(function* () {
      const f = fixture(),
        turn = f.conversations.admit({
          operationId: crypto.randomUUID(),
          text: "Request",
        }).turn
      const broken = makeActivity(
        new SqliteActivityRecords({
          ...f.db,
          all: () => {
            throw new Error("Private database failure")
          },
        }),
        f.sources,
        "bot"
      )
      const failed = yield* broken.snapshot(bot, query).pipe(Effect.exit)
      expect(
        Exit.isFailure(failed) &&
          failed.cause.reasons.some(
            (reason) =>
              reason._tag === "Fail" &&
              reason.error._tag === "ActivityStorageError"
          )
      ).toBe(true)
      f.db.run(
        "INSERT INTO chat_activity VALUES (?,?)",
        turn.id,
        '{"invalid":"timeline"}'
      )
      const corrupt = yield* f.app.conversation(turn.id).pipe(Effect.exit)
      expect(Exit.isFailure(corrupt) && Cause.hasDies(corrupt.cause)).toBe(true)
    })
)

it.effect(
  "retains ownership of stalled RPCs after the display deadline and never mutates the returned page",
  () =>
    Effect.gen(function* () {
      const entered = gate<void>(),
        reply = gate<unknown>(),
        owned: Promise<void>[] = []
      const agents = Array.from({ length: 9 }, (_, index) => ({
        id: Schema.decodeUnknownSync(AgentId)(crypto.randomUUID()),
        name: `Bot ${index}`,
      }))
      let calls = 0
      const fiber = yield* Effect.forkChild(
        activityFeed(agents, query, () =>
          activityRpc(
            ActivitySnapshot,
            () => {
              if (++calls === 4) entered.release()
              return reply.promise
            },
            (work) => {
              owned.push(work)
              work.catch(() => {})
            }
          )
        )
      )
      try {
        yield* Effect.promise(() => entered.promise)
        yield* TestClock.adjust("5 seconds")
        const page = yield* Fiber.join(fiber)
        expect(calls).toBe(4)
        expect(owned).toHaveLength(4)
        expect(page.unavailable).toEqual(agents)
        reply.release({ entries: [], issues: [] })
        yield* Effect.promise(() => Promise.all(owned))
        expect(page.entries).toEqual([])
      } finally {
        reply.release({ entries: [], issues: [] })
      }
    })
)

it.effect("does not hide a defect carrying a recoverable Activity tag", () =>
  Effect.gen(function* () {
    const exit = yield* activityFeed([bot], query, () =>
      Effect.die(unavailable())
    ).pipe(Effect.exit)
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  })
)

const rpc = (snapshot: () => Promise<unknown>): ActivityAgentRpc => ({
  activityAgents: async () => [bot],
  agentProfile: async () => ({
    ...bot,
    instructions: "",
    status: "active",
    revision: 1,
    createdAt: "",
    updatedAt: "",
  }),
  modelConnected: async () => true,
  readActivity: snapshot,
  activityConversation: async () => null,
})
test("binds native reads to the supplied owner and refuses foreign snapshot identities", async () => {
  const names: string[] = [],
    owned: Promise<void>[] = []
  const other: ActivityAgent = {
    id: Schema.decodeUnknownSync(AgentId)(crypto.randomUUID()),
    name: "Other",
  }
  const directory = activityDirectory(
    "owner",
    rpc(async () => ({ entries: [], issues: [] })),
    (name) => {
      names.push(name)
      return rpc(async () => ({
        entries: [
          {
            key: `${other.id}:turn:a`,
            at: "2026-10-01T00:00:00.000Z",
            agent: other,
            kind: "conversation",
            title: "Foreign",
            status: "done",
            attention: false,
            running: false,
            target: "conversation",
            reference: "a",
          },
        ],
        issues: [],
      }))
    },
    (work) => {
      owned.push(work)
      work.catch(() => {})
    }
  )
  const exit = await Effect.runPromiseExit(directory.snapshot(bot, query))
  expect(names).toEqual([agentObjectName("owner", homeAgentId)])
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  expect((await Promise.allSettled(owned))[0]?.status).toBe("rejected")
})

test("late malformed RPC data remains visible to the Worker owner after caller cancellation", async () => {
  const entered = gate<void>(),
    reply = gate<unknown>(),
    owned: Promise<void>[] = [],
    controller = new AbortController()
  const running = Effect.runPromiseExit(
    activityRpc(
      ActivitySnapshot,
      () => {
        entered.release()
        return reply.promise
      },
      (work) => {
        owned.push(work)
        work.catch(() => {})
      }
    ),
    { signal: controller.signal }
  )
  try {
    await entered.promise
    controller.abort()
    const exit = await running
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    reply.release({ entries: "invalid", issues: [] })
    const failures = await Promise.allSettled(owned)
    expect(failures[0]?.status).toBe("rejected")
  } finally {
    reply.release({ entries: [], issues: [] })
    await Promise.allSettled(owned)
  }
})

test("does not admit native reads for an already cancelled request", async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0,
    owned = 0
  const exit = await Effect.runPromiseExit(
    activityRpc(
      ActivitySnapshot,
      async () => {
        calls++
        return { entries: [], issues: [] }
      },
      () => {
        owned++
      }
    ),
    { signal: controller.signal }
  )
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  expect(calls).toBe(0)
  expect(owned).toBe(0)
})

test("joins an admitted native read if the host cannot register its owner", async () => {
  const entered = gate<void>(),
    reply = gate<unknown>(),
    controller = new AbortController()
  const defect = new Error("Native owner registration failed")
  let settled = false
  const running = Effect.runPromiseExit(
    activityRpc(
      ActivitySnapshot,
      () => {
        entered.release()
        return reply.promise
      },
      () => {
        throw defect
      }
    ),
    { signal: controller.signal }
  ).then((exit) => {
    settled = true
    return exit
  })
  try {
    await entered.promise
    controller.abort()
    await Promise.resolve()
    expect(settled).toBe(false)
    reply.release({ entries: [], issues: [] })
    const exit = await running
    expect(
      Exit.isFailure(exit) &&
        exit.cause.reasons.some(
          (reason) => reason._tag === "Die" && reason.defect === defect
        )
    ).toBe(true)
  } finally {
    reply.release({ entries: [], issues: [] })
    await running
  }
})

test.each(["?scope=invalid", "?filter=invalid", "?cursor=invalid"])(
  "rejects invalid HTTP input %s before catalog or bot reads",
  async (search) => {
    let calls = 0
    const unexpected = () => {
      calls++
      return Effect.die("Unexpected read")
    }
    const directory: ActivityDirectory = {
      agents: unexpected,
      find: unexpected,
      snapshot: unexpected,
      connected: unexpected,
      conversation: unexpected,
    }
    const response = await Effect.runPromise(
      activityRequest(
        directory,
        homeAgentId,
        new Request(`https://local/activity${search}`),
        "activity"
      )
    )
    expect(response.status).toBe(400)
    expect(calls).toBe(0)
  }
)

test("returns an explicit unavailable result with private native details redacted", async () => {
  const directory: ActivityDirectory = {
    agents: () => Effect.succeed([bot]),
    find: () => Effect.succeed(bot),
    connected: () => Effect.fail(unavailable()),
    snapshot: () => Effect.succeed({ entries: [], issues: [] }),
    conversation: () => Effect.succeed(null),
  }
  const response = await Effect.runPromise(
    activityRequest(
      directory,
      homeAgentId,
      new Request("https://local/activity"),
      "activity"
    )
  )
  expect(response.status).toBe(503)
  expect(await response.text()).not.toContain("Private")
})
