import { readFileSync, readdirSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import { afterEach, expect, it, vi } from "vitest"

import { AccessStore } from "../src/access/adapters/sqlite"
import { PersonalAgent } from "../src/agent/worker"
import {
  FamilyAdmission,
  type familyAdmissionApplication,
} from "../src/agents/family-admission"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { conversationPump } from "../src/conversations/pump"
import {
  Conversations,
  conversationApplication,
} from "../src/conversations/service"
import { CoordinationStore } from "../src/coordination/adapters/sqlite"
import { SqliteCredentials } from "../src/inference/adapters/credential-sqlite"
import {
  CredentialUnavailable,
  ModelCredentials,
  OAuthCredential,
  credentialApplication,
} from "../src/inference/credentials"
import { conversationFixture } from "./conversation-fixture"
import { d1 } from "./d1"
import { database } from "./database"
import { credential, catalog } from "./inference-fixture"
import { routineFixture } from "./routine-fixture"

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
  RpcTarget: class {},
  env: {},
  tracing: undefined,
}))
vi.mock("agents/lifecycle", () => ({
  Lifecycle: class {},
  LifecycleCapability: class {},
}))
vi.mock("agents/harness/pi", () => ({ PiHarness: class {} }))
vi.mock("../src/observability/events", () => ({
  reportHarness: vi.fn(),
  reportInference: vi.fn(),
  reportRecovery: vi.fn(),
  reportService: vi.fn(),
}))
const runtimes: ManagedRuntime.ManagedRuntime<
  ModelCredentials | Conversations | FamilyAdmission,
  never
>[] = []
const authDatabases: DatabaseSync[] = []
const backgroundTasks: Promise<unknown>[] = []
afterEach(async () => {
  const outcomes = await Promise.allSettled(backgroundTasks.splice(0))
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  for (const db of authDatabases.splice(0)) db.close()
  expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual(
    []
  )
})

function fixture(rotate?: () => Promise<void>) {
  const sql = new DatabaseSync(":memory:")
  authDatabases.push(sql)
  for (const directory of readdirSync("migrations/auth").sort())
    sql.exec(readFileSync(`migrations/auth/${directory}/migration.sql`, "utf8"))
  sql.exec(`INSERT INTO organization(id,name,slug,createdAt) VALUES('family','Family','family',1);
    INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('cillian','Cillian','owner@example.com',1,1,1),('claire','Claire','claire@example.com',1,1,1);
    INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES('admin','family','cillian','owner',1),('person','family','claire','member',1);`)
  const people = new Map<string, PersonalAgent>()
  const refresh = vi.fn((current: OAuthCredential) =>
    Effect.promise(async () => {
      await rotate?.()
      return Schema.decodeUnknownSync(OAuthCredential)({
        ...credential,
        access: "rotated-family-access",
        refresh: "only-owner-refresh",
        clientId: current.clientId,
        expires: Date.now() + 3_600_000,
      })
    })
  )
  function actor(owner: string, key = owner, parent = "") {
    const db = database()
    const ledger = new SqliteCredentials(
      db,
      Redacted.make(JSON.stringify({ ...credential, expires: 1 }))
    )
    const turns = new ConversationStore(db, {
      model: "gpt-6.1-sol",
      thinking: "medium",
    })
    // These historical/domain seeds stand in for an already armed lease;
    // runner.armDiscovery below is the host boundary exercised by revocation.
    const admit = (input: Parameters<ConversationStore["admit"]>[0]) =>
      turns.admit(input, undefined, undefined, undefined, {
        discoveryDeadline: Date.now() + 60_000,
      })
    const accessStore = new AccessStore(db, () =>
      Effect.succeed([
        { name: "test", description: "Test approval", mode: "ask" as const },
      ])
    )
    const notifyAccess = vi.fn()
    const abort = vi.fn(() => Effect.void)
    const armDiscovery = vi.fn(async () => Date.now() + 60_000)
    const wake = vi.fn(async () => {})
    const host: PersonalAgent = Object.create(PersonalAgent.prototype)
    const family = host as unknown as {
      familyAdmissionLayer(): ReturnType<typeof familyAdmissionApplication>
    }
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        family.familyAdmissionLayer(),
        credentialApplication(ledger, refresh),
        conversationApplication(turns)
      )
    )
    runtimes.push(runtime)
    const storage = new Map<string, unknown>()
    const pause = vi.fn(() => Effect.void)
    const coordination = new CoordinationStore(db)
    const revoke = vi.fn(() => Effect.void)
    const reconcile = vi.fn(() => Effect.void)
    const pump = Effect.runSync(conversationFixture(db))
    Object.assign(host, {
      actorRuntime: runtime,
      db,
      accessStore,
      access: { notify: notifyAccess },
      conversationExecution: { abort },
      runner: { armDiscovery, wake },
      conversationService: runtime.runSync(Conversations),
      // Prototype hosts skip initializers. HTTP requests must still reconcile
      // this host's retained pump, including its joined-release receipts.
      conversationPump: conversationPump(
        runtime.runSync(Conversations),
        pump.memory,
        pump.journal,
        pump.execution,
        pump.host
      ),
      catalogService: { read: () => Effect.succeed(catalog) },
      notifyConversation: vi.fn(),
      credentialService: runtime.runSync(ModelCredentials),
      configurationService: { read: () => Effect.succeed({ owner: parent }) },
      communication: {
        mailbox: {
          identity: () =>
            Effect.succeed({ owner, bot: parent ? "private-bot" : "home" }),
        },
      },
      routines: {
        list: () =>
          Effect.succeed([{ id: "routine", revision: 1, status: "active" }]),
        setStatus: pause,
        cancelPendingRun: () => Effect.succeed(undefined),
        inFlight: () => Effect.succeed(undefined),
      },
      conversations: turns,
      coordination: { store: coordination },
      delegationLedger: {
        catalog: () => Effect.succeed([1]),
        group: () => Effect.succeed({ turnId: "finished-request" }),
      },
      delegations: { revoke, reconcile },
      backgroundMailbox: { list: () => Effect.succeed([]) },
      env: {
        AUTH_DB: d1(sql),
        OWNER_EMAIL: "owner@example.com",
        EMAIL_REVIEW_URL: "https://pi.example/email/review",
        AGENT: {
          idFromName: (name: string) => name,
          getByName: (name: string) => people.get(name)!,
        },
      },
      ctx: {
        id: { equals: (name: string) => name === key },
        storage: {
          get: async (name: string) => storage.get(name),
          put: async (name: string, value: unknown) => {
            storage.set(name, value)
          },
        },
        waitUntil: (work: Promise<unknown>) => {
          backgroundTasks.push(work)
          // Attach rejection handling immediately; afterEach checks every result.
          void work.catch(() => {})
        },
      },
    })
    people.set(key, host)
    return {
      host,
      db,
      ledger,
      pause,
      coordination,
      revoke,
      reconcile,
      turns,
      admit,
      accessStore,
      notifyAccess,
      abort,
      armDiscovery,
      wake,
    }
  }
  return { sql, actor, refresh }
}

it("uses one refresh authority for owner, member and their private agents without copying refresh tokens", async () => {
  const f = fixture(),
    owner = f.actor("cillian"),
    member = f.actor("claire"),
    bot = f.actor("claire", "bot:claire:private-bot", "claire")
  const tokens = await Promise.all([
    owner.host.resolveModelCredential("openai"),
    member.host.resolveModelCredential("openai"),
    bot.host.resolveModelCredential("openai"),
  ])
  expect(f.refresh).toHaveBeenCalledTimes(1)
  for (const token of tokens)
    expect(token).toMatchObject({
      access: "rotated-family-access",
      refresh: "",
    })
  expect(Effect.runSync(member.ledger.read("openai"))).toBeUndefined()
  expect(Effect.runSync(bot.ledger.read("openai"))).toBeUndefined()
  expect(Effect.runSync(owner.ledger.read("openai"))).toMatchObject({
    value: { type: "oauth", refresh: Redacted.make("only-owner-refresh") },
  })
})

it("rechecks membership after a shared refresh settles before releasing a token to a removed person", async () => {
  let release!: () => void, entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = fixture(async () => {
      entered()
      await held
    }),
    owner = f.actor("cillian"),
    member = f.actor("claire")
  const result = member.host.resolveModelCredential("openai")
  const rejected = expect(result).rejects.toBeDefined()
  await started
  f.sql.exec("DELETE FROM member WHERE userId='claire'")
  release()
  await rejected
  expect(member.pause).toHaveBeenCalledTimes(1)
  expect(f.refresh).toHaveBeenCalledTimes(1)
  expect(Effect.runSync(member.ledger.read("openai"))).toBeUndefined()
  expect(Effect.runSync(owner.ledger.read("openai"))).toBeDefined()
})
it("immediately shares an in-product replacement with members and their private agents without copying refresh tokens", async () => {
  const f = fixture(),
    owner = f.actor("cillian"),
    member = f.actor("claire"),
    bot = f.actor("claire", "bot:claire:private-bot", "claire")
  await owner.host.resolveModelCredential("openai")
  await owner.host.credentialService
    .install(
      Schema.decodeUnknownSync(OAuthCredential)({
        ...credential,
        clientId: "new-registration",
        access: "new-family-access",
        refresh: "private-new-refresh",
        expires: Date.now() + 3_600_000,
      })
    )
    .pipe(Effect.runPromise)
  for (const actor of [owner, member, bot])
    expect(await actor.host.resolveModelCredential("openai")).toMatchObject({
      access: "new-family-access",
      refresh: "",
    })
  expect(Effect.runSync(member.ledger.read("openai"))).toBeUndefined()
  expect(Effect.runSync(bot.ledger.read("openai"))).toBeUndefined()
  expect(await owner.host.reconnectChatGPTAction()).toHaveProperty(
    "status",
    "sign_in_required"
  )
  expect(await member.host.reconnectChatGPTAction()).toHaveProperty("error")
})

it("pauses old scheduled work when removal and a new membership occur between actor wakes", async () => {
  const f = fixture()
  f.actor("cillian")
  const member = f.actor("claire")
  await member.host.familyAdmission()
  f.sql.exec(
    "DELETE FROM member WHERE userId='claire'; INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES('new-person','family','claire','member',1)"
  )
  expect(await member.host.familyAdmission()).toMatchObject({
    owner: "claire",
    joinedAt: 1,
  })
  expect(member.pause).toHaveBeenCalledTimes(1)
  expect(Effect.runSync(member.coordination.closed("finished-request"))).toBe(
    true
  )
  expect(member.revoke).toHaveBeenCalledWith("finished-request")
  expect(member.revoke.mock.invocationCallOrder[0]).toBeLessThan(
    member.reconcile.mock.invocationCallOrder[0]!
  )
  expect(member.reconcile).toHaveBeenCalledWith("finished-request", {
    allowDispatch: false,
  })
  await member.host.familyAdmission()
  expect(member.pause).toHaveBeenCalledTimes(1)
})

it.each([false, true])(
  "saves Stop and cancels access before waking owned cleanup after membership replacement, prearm fails=%s",
  async (prearmFails) => {
    const f = fixture()
    f.actor("cillian")
    const member = f.actor("claire")
    await member.host.familyAdmission()
    const id = "original-running-root"
    await Effect.runPromise(
      member.admit({ operationId: id, text: "Original private work" })
    )
    await Effect.runPromise(
      member.turns.submitted(id, "original-native-session")
    )
    const before = await Effect.runPromise(member.turns.get(id))
    expect(before).toMatchObject({ status: "running" })
    await Effect.runPromise(
      member.accessStore.begin({
        id: "approval",
        turnId: id,
        tool: "test",
        input: "private",
      })
    )
    expect(
      await Effect.runPromise(member.accessStore.get("approval"))
    ).toMatchObject({ status: "pending" })
    if (prearmFails)
      member.armDiscovery.mockRejectedValueOnce(
        new Error("Discovery unavailable")
      )
    // A wake may re-enter admission; it must not run native work before the
    // durable revocation is visible, or deadlock the generation transition.
    member.wake.mockImplementationOnce(async () => {
      expect(await Effect.runPromise(member.turns.get(id))).toMatchObject({
        status: "stopping",
      })
      expect(
        await Effect.runPromise(member.accessStore.get("approval"))
      ).toMatchObject({ status: "cancelled" })
      await member.host.familyAdmission()
    })
    f.sql.exec(
      "DELETE FROM member WHERE userId='claire'; INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES('replacement','family','claire','member',1)"
    )
    expect(await member.host.familyAdmission()).toMatchObject({
      owner: "claire",
    })
    await member.wake.mock.results[0]?.value
    const stopped = await Effect.runPromise(member.turns.get(id))
    expect(stopped).toMatchObject({
      id,
      text: "Original private work",
      session_id: "original-native-session",
      status: "stopping",
      control: { owner: null, unconfirmed: prearmFails ? "stop" : null },
    })
    expect(stopped!.revision).toBeGreaterThan(before!.revision)
    expect(member.armDiscovery).toHaveBeenCalledOnce()
    expect(member.notifyAccess).toHaveBeenCalledOnce()
    expect(member.wake).toHaveBeenCalledOnce()
    expect(member.abort).not.toHaveBeenCalled()
  }
)

it("fences completed main sessions without child groups when membership changes", async () => {
  const f = fixture()
  f.actor("cillian")
  const member = f.actor("claire")
  await member.host.familyAdmission()
  // More than one discovery page, and no delegation group owns these sessions.
  for (let n = 0; n < 25; n++) {
    const id = `old-main-${n}`
    await Effect.runPromise(member.admit({ operationId: id, text: id }))
    await Effect.runPromise(member.turns.saveSession(id, String(100 + n)))
    member.db.run("UPDATE chat_turns SET status='done' WHERE id=?", id)
  }
  await Effect.runPromise(
    member.coordination.accept(
      {
        id: "old-message",
        operationId: "old-operation",
        from: { sessionId: "old-main-0", agentId: "main" },
        to: { sessionId: "old-main-24", agentId: "main" },
        text: "Continue old work after re-invitation",
        provenance: {
          author: { kind: "agent", id: "private-bot", sessionId: "old-main-0" },
          conversationId: "private-bot",
          recipients: [],
        },
        createdAt: Date.now(),
        deadline: Date.now() + 600000,
      },
      Date.now() + 60_000
    )
  )
  f.sql.exec(
    "DELETE FROM member WHERE userId='claire'; INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES('replacement','family','claire','member',1)"
  )
  await member.host.familyAdmission()
  expect(
    (await Effect.runPromise(member.coordination.get("old-message")))?.state
  ).toBe("failed")
  for (let n = 0; n < 25; n++)
    expect(
      await Effect.runPromise(member.coordination.closed(`old-main-${n}`))
    ).toBe(true)
  expect(
    (await Effect.runPromise(member.turns.get("old-main-0")))?.status
  ).toBe("done")
})

it("does not let concurrent old-generation cleanup fence newly authorized work", async () => {
  const f = fixture()
  f.actor("cillian")
  const member = f.actor("claire")
  await member.host.familyAdmission()
  f.sql.exec(
    "DELETE FROM member WHERE userId='claire'; INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES('replacement','family','claire','member',1)"
  )
  let release!: () => void, entered!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  member.pause.mockImplementationOnce(() =>
    Effect.promise(async () => {
      entered()
      await held
    })
  )
  const earlier = member.host.familyAdmission()
  await started
  // A second admission must join cleanup instead of admitting new work early.
  let laterSettled = false
  const later = member.host.familyAdmission().then(async (value) => {
    await Effect.runPromise(
      member.admit({
        operationId: "fresh-work",
        text: "Authorized under the new membership",
      })
    )
    await Effect.runPromise(member.turns.saveSession("fresh-work", "9000"))
    member.db.run("UPDATE chat_turns SET status='done' WHERE id='fresh-work'")
    laterSettled = true
    return value
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const admittedEarly = laterSettled
  release()
  await Promise.all([earlier, later])
  expect(admittedEarly).toBe(false)
  expect(
    await Effect.runPromise(member.coordination.closed("fresh-work"))
  ).toBe(false)
  expect(member.pause).toHaveBeenCalledTimes(1)
})

it("commits known detached-child revocation before starting cleanup-only reconciliation", async () => {
  const f = fixture()
  f.actor("cillian")
  const member = f.actor("claire")
  await member.host.familyAdmission()
  f.sql.exec(
    "DELETE FROM member WHERE userId='claire'; INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES('replacement','family','claire','member',1)"
  )
  let entered!: () => void,
    release!: () => void,
    committed = false
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  member.revoke.mockImplementationOnce(() =>
    Effect.promise(async () => {
      entered()
      await held
      committed = true
    })
  )
  member.reconcile.mockImplementationOnce(() =>
    Effect.sync(() => {
      expect(committed).toBe(true)
    })
  )
  const fencing = member.host.familyAdmission()
  await started
  expect(member.reconcile).not.toHaveBeenCalled()
  release()
  await fencing
  expect(member.revoke).toHaveBeenCalledWith("finished-request")
  expect(member.reconcile).toHaveBeenCalledWith("finished-request", {
    allowDispatch: false,
  })
})

it("lets owned cleanup recheck membership after durable fencing without a cycle", async () => {
  const f = fixture()
  f.actor("cillian")
  const member = f.actor("claire")
  await member.host.familyAdmission()
  f.sql.exec(
    "DELETE FROM member WHERE userId='claire'; INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES('replacement','family','claire','member',1)"
  )
  let settled!: () => void
  const cleanup = new Promise<void>((resolve) => {
    settled = resolve
  })
  member.reconcile.mockImplementationOnce(() =>
    Effect.promise(async () => {
      await member.host.familyAdmission()
      settled()
    })
  )
  expect(await member.host.familyAdmission()).toMatchObject({ owner: "claire" })
  await cleanup
  expect(
    await Effect.runPromise(member.coordination.closed("finished-request"))
  ).toBe(true)
})

it("retries a failed membership transition instead of retaining a rejected barrier", async () => {
  const f = fixture()
  f.actor("cillian")
  const member = f.actor("claire")
  await member.host.familyAdmission()
  f.sql.exec(
    "DELETE FROM member WHERE userId='claire'; INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES('replacement','family','claire','member',1)"
  )
  member.pause.mockImplementationOnce(() =>
    Effect.die(new Error("Synthetic transition failure"))
  )
  await expect(member.host.familyAdmission()).rejects.toBeDefined()
  expect(await member.host.familyAdmission()).toMatchObject({ owner: "claire" })
  expect(member.pause).toHaveBeenCalledTimes(2)
})

it.each([false, true])(
  "discards a delayed lookup after another admission changes membership, initialized=%s",
  async (initialized) => {
    const f = fixture()
    f.actor("cillian")
    const member = f.actor("claire")
    if (initialized) await member.host.familyAdmission()
    let release!: () => void, entered!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const stateHost = member.host as unknown as {
      familyStateProgram(): Effect.Effect<
        Awaited<ReturnType<PersonalAgent["familyAdmission"]>>,
        CredentialUnavailable
      >
    }
    const stateProgram = stateHost.familyStateProgram.bind(member.host)
    vi.spyOn(stateHost, "familyStateProgram").mockImplementationOnce(() =>
      Effect.gen(function* () {
        const snapshot = yield* stateProgram()
        yield* Effect.promise(async () => {
          entered()
          await held
        })
        return snapshot
      })
    )
    const delayed = member.host.familyAdmission()
    await started
    f.sql.exec(
      "DELETE FROM member WHERE userId='claire'; INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES('replacement','family','claire','member',1)"
    )
    await member.host.familyAdmission()
    await Effect.runPromise(
      member.admit({
        operationId: "fresh-after-read",
        text: "New membership",
      })
    )
    await Effect.runPromise(
      member.turns.saveSession("fresh-after-read", "9001")
    )
    member.db.run(
      "UPDATE chat_turns SET status='done' WHERE id='fresh-after-read'"
    )
    release()
    await delayed
    expect(
      await Effect.runPromise(member.coordination.closed("fresh-after-read"))
    ).toBe(false)
    expect(member.pause).toHaveBeenCalledTimes(initialized ? 1 : 0)
  }
)

it("fails closed when live membership cannot be read", async () => {
  const f = fixture()
  f.actor("cillian")
  const member = f.actor("claire")
  f.sql.exec("DROP TABLE member")
  await expect(
    member.host.resolveModelCredential("openai")
  ).rejects.toBeDefined()
  expect(f.refresh).not.toHaveBeenCalled()
})

it("chat model changes use the existing settings API and remain private to the current agent", async () => {
  const f = fixture(),
    owner = f.actor("cillian"),
    member = f.actor("claire")
  const response = await member.host.modelSettingsAction({
    action: "set",
    job: "conversation",
    model: "gpt-6-luna",
    thinking: "low",
  })
  expect(response).toMatchObject({ model: "gpt-6-luna", thinking: "low" })
  expect(
    await member.host.modelSettingsAction({ action: "read" })
  ).toMatchObject({ selection: { model: "gpt-6-luna" } })
  expect(
    await owner.host.modelSettingsAction({ action: "read" })
  ).toMatchObject({ selection: { model: "gpt-6.1-sol" } })
  expect(
    await member.host.modelSettingsAction({
      action: "set",
      job: "conversation",
      model: "nonexistent-model",
      thinking: "low",
    })
  ).toHaveProperty("error")
  expect(
    await member.host.modelSettingsAction({ action: "read" })
  ).toMatchObject({ selection: { model: "gpt-6-luna" } })
})

it.each(["removed", "replaced"] as const)(
  "cancels manual pending work on an already-paused routine when membership is %s",
  async (change) => {
    const f = fixture()
    f.actor("cillian")
    const member = f.actor("claire")
    await member.host.familyAdmission()
    const routines = routineFixture(member.db, () => true)
    Object.assign(member.host, { routines: routines.service })
    const routine = routines.save({
      id: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      expectedRevision: 0,
      title: "Paused routine",
      prompt: "Read saved facts.",
      status: "paused",
      schedule: { type: "once", at: Date.now() + 3600_000 },
    }).routine
    const pending = routines.runNow({
      id: routine.id,
      operationId: crypto.randomUUID(),
      expectedRevision: routine.revision,
    }).run!
    f.sql.exec("DELETE FROM member WHERE userId='claire'")
    if (change === "replaced")
      f.sql.exec(
        "INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES('replacement','family','claire','member',1)"
      )
    const current = await member.host.familyAdmission()
    expect(current?.membershipId ?? null).toBe(
      change === "replaced" ? "replacement" : null
    )
    expect(routines.runs()).toMatchObject([
      { id: pending.id, turnId: pending.turnId, status: "cancelled" },
    ])
    expect(routines.inFlight()).toBeUndefined()
    expect(routines.get(routine.id)).toMatchObject({
      status: "paused",
      revision: routine.revision,
    })
    expect(await Effect.runPromise(member.turns.recent())).toHaveLength(0)
  }
)
