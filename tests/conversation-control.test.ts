import { Cause, Effect, Exit, Scheduler } from "effect"
import { expect, it } from "vitest"

import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import {
  advanceRootRun,
  completionDecision,
  type RootRunEvent,
} from "../src/conversations/root-run.machine"
import { conversationControl } from "../src/conversations/turns"
import { agentMigrationManifest } from "../src/storage/migration-manifest"
import { migrateSqlite } from "../src/storage/migrations"
import { database, corrupt } from "./database"

const defaults = { model: "test", thinking: "off" as const }
const lease = () => ({ discoveryDeadline: Date.now() + 60_000 })
const run = <A, E>(effect: Effect.Effect<A, E>, budget = 3) =>
  Effect.runPromise(
    effect.pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, budget))
  )
function fixture() {
  const db = database(),
    store = new ConversationStore(db, defaults)
  const admit = (id: string, mode: "followUp" | "steer" = "followUp") =>
    store.admit(
      { operationId: id, text: id, mode },
      undefined,
      undefined,
      undefined,
      lease()
    )
  const root = Effect.runSync(admit("root")).turn
  return { db, store, admit, root }
}
it("requires fresh discovery only for a new admission and preserves exact replay", () => {
  const { store, root } = fixture()
  expect(
    Effect.runSync(
      store.admit({ operationId: root.id, text: root.text, mode: root.mode })
    ).accepted
  ).toBe(false)
  for (const options of [undefined, { discoveryDeadline: Date.now() - 1 }]) {
    const result = Effect.runSync(
      store
        .admit(
          { operationId: "new", text: "new" },
          undefined,
          undefined,
          undefined,
          options
        )
        .pipe(Effect.result)
    )
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "ConversationStorageError",
        operation: "admission discovery",
      },
    })
  }
  expect(Effect.runSync(store.get("new"))).toBeUndefined()
})
it.each([3, 7, 11])(
  "atomically grants one native owner even under scheduler budget %i",
  async (budget) => {
    const { store, root } = fixture()
    const claims = await run(
      Effect.all(
        [
          store.claimControl(root.id, "one", Date.now() + 60_000),
          store.claimControl(root.id, "two", Date.now() + 60_000),
        ],
        { concurrency: "unbounded" }
      ),
      budget
    )
    expect(claims.filter(Boolean)).toHaveLength(1)
    const winner = claims.find(Boolean)!,
      owner = conversationControl(winner).owner!
    expect(winner.revision).toBe(root.revision + 1)
    expect(conversationControl(winner).attempts).toBe(1)
    expect(
      await run(
        store.claimControl(root.id, "late", Date.now() + 120_000),
        budget
      )
    ).toBeUndefined()
    expect(await run(store.releaseControl(root.id, "wrong"), budget)).toBe(
      false
    )
    await run(store.submitted(root.id, "wrong-session"), budget)
    expect((await run(store.get(root.id), budget))?.session_id).toBeNull()
    await run(store.submitted(root.id, "session", owner), budget)
    expect((await run(store.get(root.id), budget))?.status).toBe("running")
    expect(await run(store.releaseControl(root.id, owner, true), budget)).toBe(
      true
    )
    expect(
      conversationControl((await run(store.get(root.id), budget))!)
    ).toEqual({ owner: null, deadline: null, unconfirmed: null, attempts: 0 })
  }
)
it("Stop preserves ownership, accepts late session binding, and fences retries until joined release", async () => {
  const { store, root } = fixture()
  const claimed = (await run(
    store.claimControl(root.id, "owner", Date.now() + 60_000)
  ))!
  await run(store.requestStop(root.id))
  await run(store.saveSession(root.id, "acquired-after-stop", "owner"))
  await run(store.submitted(root.id, "acquired-after-stop", "owner"))
  let stopped = (await run(store.get(root.id)))!
  expect(stopped).toMatchObject({
    status: "stopping",
    session_id: "acquired-after-stop",
    control: { owner: "owner", unconfirmed: "stop" },
  })
  expect(
    await run(
      store.retryStop(root.id, stopped.revision, lease().discoveryDeadline)
    )
  ).toBe(false)
  await run(
    store.releaseControl(root.id, "owner", false, {
      failed: true,
      timedOut: true,
      inspected: false,
      phase: "handoff",
      error: "late failure",
    })
  )
  stopped = (await run(store.get(root.id)))!
  expect(stopped.control?.unconfirmed).toBe("stop")
  expect(stopped.revision).toBeGreaterThan(claimed.revision)
  expect(
    await run(
      store.retryStop(root.id, stopped.revision - 1, lease().discoveryDeadline)
    )
  ).toBe(false)
  expect(
    await run(
      store.retryStop(root.id, stopped.revision, lease().discoveryDeadline)
    )
  ).toBe(true)
  expect(
    await run(
      store.retryStop(root.id, stopped.revision, lease().discoveryDeadline)
    )
  ).toBe(false)
  expect(
    await run(
      store.releaseControl(root.id, "owner", false, {
        failed: true,
        timedOut: true,
        inspected: false,
        phase: "handoff",
        error: "stale",
      })
    )
  ).toBe(false)
})
it("persists the third failed attempt and uncertainty in the same owner release", async () => {
  const { db, store, root } = fixture()
  for (let attempt = 1; attempt <= 3; attempt++) {
    const owner = "owner-" + attempt
    const claimed = (await run(
      store.claimControl(root.id, owner, Date.now() + 60_000)
    ))!
    expect(claimed.control?.attempts).toBe(attempt)
    if (attempt === 3) {
      db.run(
        "CREATE TRIGGER reject_release BEFORE UPDATE ON chat_turns WHEN OLD.id='root' AND json_extract(OLD.control,'$.owner') IS NOT NULL AND json_extract(NEW.control,'$.owner') IS NULL BEGIN SELECT RAISE(ABORT,'release failure'); END"
      )
      expect(
        await run(
          store
            .releaseControl(root.id, owner, false, {
              failed: true,
              phase: "observe",
              timedOut: false,
              inspected: false,
            })
            .pipe(Effect.result)
        )
      ).toMatchObject({ _tag: "Failure" })
      expect((await run(store.get(root.id)))?.control).toMatchObject({
        owner,
        attempts: 3,
      })
      expect(
        await run(store.claimControl(root.id, "bypass", Date.now() + 60_000))
      ).toBeUndefined()
      db.run("DROP TRIGGER reject_release")
    }
    await run(
      store.releaseControl(root.id, owner, false, {
        failed: true,
        phase: "observe",
        timedOut: false,
        inspected: false,
        error: "checked failure",
      })
    )
  }
  const exhausted = (await run(store.get(root.id)))!
  expect(exhausted).toMatchObject({
    status: "queued",
    control: { owner: null, attempts: 3, unconfirmed: "observe" },
  })
  expect(
    await run(store.claimControl(root.id, "fourth", Date.now() + 60_000))
  ).toBeUndefined()
  await run(store.requestStop(root.id, lease()))
  const firstStop = (await run(store.get(root.id)))!
  expect(firstStop.control).toMatchObject({ attempts: 0, unconfirmed: null })
  const stopping = (await run(
    store.claimControl(root.id, "first-stop", Date.now() + 60_000, "stop")
  ))!
  expect(stopping.control?.attempts).toBe(1)
  await run(
    store.releaseControl(root.id, "first-stop", false, {
      failed: true,
      phase: "stop",
      timedOut: true,
      inspected: false,
    })
  )
  const unconfirmed = (await run(store.get(root.id)))!
  await run(store.requestStop(root.id, lease()))
  expect((await run(store.get(root.id)))?.control).toEqual(unconfirmed.control)
  expect((await run(store.get(root.id)))?.revision).toBe(unconfirmed.revision)
  expect(
    await run(store.claimControl(root.id, "automatic", Date.now() + 60_000))
  ).toBeUndefined()
  expect(
    await run(
      store.retryStop(root.id, unconfirmed.revision, lease().discoveryDeadline)
    )
  ).toBe(true)
  expect(
    await run(
      store.claimControl(root.id, "explicit-stop", Date.now() + 60_000, "stop")
    )
  ).toBeDefined()
})
it("cold restoration keeps identity and uncertainty, never grants automatic resend", async () => {
  const { store, root } = fixture()
  await run(store.claimControl(root.id, "crashed", Date.now() + 60_000))
  await run(store.saveSession(root.id, "native-original", "crashed"))
  await run(store.savePrompt(root.id, "immutable prompt", "crashed"))
  await run(store.restoreControl())
  const recovered = (await run(store.get(root.id)))!
  expect(recovered).toMatchObject({
    id: root.id,
    creation: root.creation,
    session_id: "native-original",
    prompt: "immutable prompt",
    status: "queued",
    control: { owner: null, attempts: 1, unconfirmed: "observe" },
  })
  await run(store.restoreControl())
  expect((await run(store.get(root.id)))?.revision).toBe(recovered.revision)
  expect(
    await run(store.claimControl(root.id, "automatic", Date.now() + 60_000))
  ).toBeUndefined()
  const inspecting = (await run(
    store.claimControl(
      root.id,
      "inspect",
      Date.now() + 60_000,
      "inspect",
      recovered.revision
    )
  ))!
  expect(inspecting.control?.attempts).toBe(1)
  await run(
    store.releaseControl(root.id, "inspect", false, {
      failed: false,
      phase: "observe",
      timedOut: false,
      inspected: true,
    })
  )
  expect((await run(store.get(root.id)))?.control).toMatchObject({
    attempts: 1,
    unconfirmed: "observe",
  })
})
it("fences exhaustion against active, newer released, and ineligible Lifecycle attempts", async () => {
  const { store, root } = fixture()
  const first = (await run(
    store.claimControl(root.id, "one", Date.now() + 60_000)
  ))!
  expect(
    await run(
      store.exhaustControl(
        root.id,
        first.revision,
        "handoff",
        "bad",
        () => true
      )
    )
  ).toBe(false)
  await run(store.releaseControl(root.id, "one"))
  const second = (await run(
    store.claimControl(root.id, "two", Date.now() + 60_000)
  ))!
  await run(store.releaseControl(root.id, "two"))
  expect(
    await run(
      store.exhaustControl(
        root.id,
        first.revision,
        "handoff",
        "stale",
        () => true
      )
    )
  ).toBe(false)
  expect(
    await run(
      store.exhaustControl(
        root.id,
        second.revision,
        "handoff",
        "ineligible",
        () => false
      )
    )
  ).toBe(false)
  expect(
    await run(
      store.exhaustControl(
        root.id,
        second.revision,
        "handoff",
        "current",
        () => true
      )
    )
  ).toBe(true)
  expect((await run(store.get(root.id)))?.error).toBe("current")
})
it("rejects duplicate, foreign and stale completion sets before changing any receipt", () => {
  const { store, root, admit } = fixture()
  Effect.runSync(admit("child", "steer"))
  const current = Effect.runSync(store.get(root.id))!,
    members = Effect.runSync(store.members(root.id))
  for (const outcomes of [
    [
      { id: root.id, delivery: "answered" as const },
      { id: root.id, delivery: "answered" as const },
    ],
    [
      { id: root.id, delivery: "answered" as const },
      { id: "foreign", delivery: "answered" as const },
    ],
  ])
    expect(
      completionDecision(current, current, members, outcomes, "answer", null)
    ).toBeUndefined()
  expect(
    completionDecision(
      root,
      current,
      members,
      members.map((member) => ({ id: member.id, delivery: "answered" })),
      "answer",
      null
    )
  ).toBeUndefined()
  expect(Effect.runSync(store.get(root.id))?.answer).toBe("")
})
it("rejects unsupported versions, malformed control and executable event descriptors as defects", async () => {
  const { db, store, root } = fixture()
  for (const event of [
    { type: "PREPARE", actions: [{ type: "resend" }] },
    {
      type: "CLAIM",
      owner: "x",
      deadline: "bad",
      now: 0,
      mode: "automatic",
      expectedRevision: null,
    },
    { type: "UNKNOWN" },
  ])
    expect(() => advanceRootRun(root, event as RootRunEvent)).toThrow()
  for (const query of [
    "UPDATE chat_turns SET schema_version=2 WHERE id='root'",
    "UPDATE chat_turns SET workflow_version=2 WHERE id='root'",
    'UPDATE chat_turns SET control=\'{"owner":"x","deadline":null,"unconfirmed":null}\' WHERE id=\'root\'',
    'UPDATE chat_turns SET control=\'{"owner":null,"deadline":null,"unconfirmed":null,"attempts":-1}\' WHERE id=\'root\'',
  ]) {
    corrupt(db, query)
    const exit = await run(Effect.exit(store.get(root.id)))
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    db.run(
      'UPDATE chat_turns SET schema_version=1,workflow_version=1,control=\'{"owner":null,"deadline":null,"unconfirmed":null}\' WHERE id=\'root\''
    )
  }
})
it("migrates legacy rows without changing receipts, identities, revisions or native tables", () => {
  const db = database({ migrate: false })
  const index = agentMigrationManifest.versions.findIndex((version) =>
    version.statements.some(
      (sql) =>
        sql.includes("ADD") &&
        sql.includes("schema_version") &&
        sql.includes("chat_turns")
    )
  )
  expect(index).toBeGreaterThan(0)
  for (const version of agentMigrationManifest.versions.slice(0, index)) {
    for (const statement of version.statements) db.run(statement)
    db.run(
      "INSERT INTO __durable_pi_migrations VALUES (?,?)",
      version.id,
      version.checksum
    )
  }
  db.run(
    "INSERT INTO chat_turns(id,text,status,created_at,creation,revision,session_id,prompt,delivery) VALUES ('root','keep','running','2026-01-01','immutable',7,'native-session','pinned','consumed')"
  )
  db.run(
    "INSERT INTO chat_turns(id,text,status,created_at,parent_id,mode,delivery) VALUES ('child','steer','running','2026-01-02','root','steer','accepted')"
  )
  db.run("CREATE TABLE pi_native_sentinel(id TEXT PRIMARY KEY, value TEXT)")
  db.run("INSERT INTO pi_native_sentinel VALUES ('original','native receipt')")
  Effect.runSync(migrateSqlite(db, { audit: true }))
  const store = new ConversationStore(db, defaults)
  expect(Effect.runSync(store.get("root"))).toMatchObject({
    schemaVersion: 1,
    workflowVersion: 1,
    id: "root",
    creation: "immutable",
    revision: 7,
    session_id: "native-session",
    prompt: "pinned",
    delivery: "consumed",
    control: { owner: null, attempts: 0, unconfirmed: null },
  })
  expect(Effect.runSync(store.get("child"))).toMatchObject({
    id: "child",
    parent_id: "root",
    mode: "steer",
    delivery: "accepted",
  })
  expect(db.all("SELECT * FROM pi_native_sentinel")).toEqual([
    { id: "original", value: "native receipt" },
  ])
  expect(db.all("PRAGMA foreign_key_check")).toEqual([])
})

it("preserves a terminal native failure explanation when confirmed inspection clears old uncertainty", async () => {
  const { store, root } = fixture()
  await run(store.claimControl(root.id, "interrupted", Date.now() + 60_000))
  await run(store.saveSession(root.id, "native", "interrupted"))
  await run(store.restoreControl())
  const current = (await run(store.get(root.id)))!
  const inspected = (await run(
    store.claimControl(
      root.id,
      "inspection",
      Date.now() + 60_000,
      "inspect",
      current.revision
    )
  ))!
  expect(
    await run(
      store.finish(
        inspected,
        [{ id: root.id, delivery: "unanswered" }],
        "",
        "Native execution failed",
        "inspection"
      )
    )
  ).toBe(true)
  await run(
    store.releaseControl(root.id, "inspection", true, {
      failed: false,
      timedOut: false,
      inspected: true,
      phase: "observe",
    })
  )
  expect(await run(store.get(root.id))).toMatchObject({
    status: "failed",
    error: "Native execution failed",
    control: { owner: null, unconfirmed: null },
  })
})

it.each([
  { phase: "handoff" as const, timedOut: true, attempt: 1 },
  { phase: "observe" as const, timedOut: false, attempt: 3 },
])(
  "keeps fresh Stop available after a held $phase attempt $attempt fails",
  async ({ phase, timedOut, attempt }) => {
    const { store, root } = fixture()
    for (let index = 1; index < attempt; index++) {
      const owner = "earlier-" + index
      await run(store.claimControl(root.id, owner, Date.now() + 60_000))
      await run(
        store.releaseControl(root.id, owner, false, {
          failed: true,
          timedOut: false,
          inspected: false,
          phase,
        })
      )
    }
    await run(store.claimControl(root.id, "held-native", Date.now() + 60_000))
    await run(store.saveSession(root.id, "original-native", "held-native"))
    await run(store.requestStop(root.id, lease()))
    const stopped = (await run(store.get(root.id)))!
    expect(stopped).toMatchObject({
      status: "stopping",
      control: { owner: "held-native", attempts: 1, unconfirmed: null },
    })
    expect(
      await run(
        store.claimControl(root.id, "early-stop", Date.now() + 60_000, "stop")
      )
    ).toBeUndefined()
    await run(
      store.releaseControl(root.id, "held-native", false, {
        failed: true,
        timedOut,
        inspected: false,
        phase,
        error: "old work failed",
      })
    )
    const released = (await run(store.get(root.id)))!
    expect(released).toMatchObject({
      status: "stopping",
      error: null,
      session_id: "original-native",
      control: { owner: null, attempts: 0, unconfirmed: null },
    })
    expect(
      await run(
        store.exhaustControl(
          root.id,
          released.revision,
          phase,
          "old job exhausted",
          () => true
        )
      )
    ).toBe(false)
    const aborting = (await run(
      store.claimControl(root.id, "abort-owner", Date.now() + 60_000)
    ))!
    expect(aborting).toMatchObject({
      status: "stopping",
      session_id: "original-native",
      control: { owner: "abort-owner", attempts: 1, unconfirmed: null },
    })
    await run(
      store.releaseControl(root.id, "abort-owner", false, {
        failed: true,
        timedOut: true,
        inspected: false,
        phase: "stop",
        error: "abort timed out",
      })
    )
    const uncertain = (await run(store.get(root.id)))!
    expect(uncertain).toMatchObject({
      status: "stopping",
      control: { owner: null, attempts: 1, unconfirmed: "stop" },
      error: "abort timed out",
    })
    await run(store.requestStop(root.id, lease()))
    expect((await run(store.get(root.id)))?.revision).toBe(uncertain.revision)
    expect((await run(store.get(root.id)))?.control).toEqual(uncertain.control)
  }
)

it("counts an abort performed by the existing owner against the fresh Stop budget", async () => {
  const { store, root } = fixture()
  await run(store.claimControl(root.id, "owner", Date.now() + 60_000))
  await run(store.requestStop(root.id, lease()))
  await run(
    store.releaseControl(root.id, "owner", false, {
      failed: true,
      timedOut: false,
      inspected: false,
      phase: "stop",
    })
  )
  expect((await run(store.get(root.id)))?.control).toMatchObject({
    owner: null,
    attempts: 1,
    unconfirmed: null,
  })
  for (const owner of ["stop-2", "stop-3"]) {
    await run(store.claimControl(root.id, owner, Date.now() + 60_000, "stop"))
    await run(
      store.releaseControl(root.id, owner, false, {
        failed: true,
        timedOut: false,
        inspected: false,
        phase: "stop",
      })
    )
  }
  const exhausted = (await run(store.get(root.id)))!
  expect(exhausted.control).toMatchObject({
    owner: null,
    attempts: 3,
    unconfirmed: "stop",
  })
  await run(store.requestStop(root.id, lease()))
  expect((await run(store.get(root.id)))?.control).toEqual(exhausted.control)
  expect(
    await run(
      store.claimControl(root.id, "fourth", Date.now() + 60_000, "stop")
    )
  ).toBeUndefined()
})
