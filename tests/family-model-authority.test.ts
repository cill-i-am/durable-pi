import { readFileSync, readdirSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import { afterEach, expect, it, vi } from "vitest"

import { PersonalAgent } from "../src/agent/worker"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import {
  Conversations,
  conversationApplication,
} from "../src/conversations/service"
import { SqliteCredentials } from "../src/inference/adapters/credential-sqlite"
import {
  ModelCredentials,
  OAuthCredential,
  credentialApplication,
} from "../src/inference/credentials"
import { d1 } from "./d1"
import { database } from "./database"
import { credential, catalog } from "./inference-fixture"

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
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
  ModelCredentials | Conversations,
  never
>[] = []
const authDatabases: DatabaseSync[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  for (const db of authDatabases.splice(0)) db.close()
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
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        credentialApplication(ledger, refresh),
        conversationApplication(turns)
      )
    )
    runtimes.push(runtime)
    const storage = new Map<string, unknown>()
    const pause = vi.fn(() => Effect.void)
    const host: PersonalAgent = Object.create(PersonalAgent.prototype)
    Object.assign(host, {
      actorRuntime: runtime,
      conversationService: runtime.runSync(Conversations),
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
      },
      conversations: { unfinished: () => Effect.succeed([]) },
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
          void work.catch(() => {})
        },
      },
    })
    people.set(key, host)
    return { host, db, ledger, pause }
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
  await member.host.familyAdmission()
  expect(member.pause).toHaveBeenCalledTimes(1)
})

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
