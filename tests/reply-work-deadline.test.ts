import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { inspect } from "node:util"

import { Clock, Deferred, Effect, Fiber } from "effect"
import { describe, expect, it } from "vitest"

import { homeAgentId } from "../src/agents/domain"
import { emailMessages, emailRetries } from "../src/email/adapters/schema"
import { EmailStore } from "../src/email/adapters/sqlite"
import { EmailUnavailable } from "../src/email/contracts"
import { emailPump, type EmailPumpHost } from "../src/email/pump"
import {
  REPLY_LEASE_MS,
  type ReplyProgress,
  type ReplyWork,
} from "../src/replies/contracts"
import { agentMigrationManifest } from "../src/storage/migration-manifest"
import { migrateSqlite } from "../src/storage/migrations"
import { makeNodeSqlite } from "../src/storage/node"
import {
  whatsappMessages,
  whatsappRetries,
} from "../src/whatsapp/adapters/schema"
import { WhatsAppStore } from "../src/whatsapp/adapters/sqlite"
import { WhatsAppUnavailable } from "../src/whatsapp/contracts"
import { whatsappPump, type WhatsAppPumpHost } from "../src/whatsapp/pump"
import { database } from "./database"
import { fixtureClock } from "./routine-fixture"

type Channel = "email" | "whatsapp"
type WorkRow = {
  id: string
  state: string
  revision: number
  work_deadline: number | null
  attempt_id: string | null
  send_deadline: number | null
}

async function fixture(channel: Channel) {
  const db = database(),
    email = new EmailStore(db),
    whatsapp = new WhatsAppStore(db),
    initialNow = Date.now(),
    id = crypto.randomUUID()
  let now = initialNow,
    failure = "",
    armHook: (deadline: number) => Effect.Effect<void> = () => Effect.void
  const liveClock = Effect.runSync(Clock.Clock)
  const clock: Clock.Clock = {
    ...fixtureClock(() => now),
    sleep: (duration) => liveClock.sleep(duration),
  }
  const run = <A>(effect: Effect.Effect<A, unknown>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(Clock.Clock, clock)))
  const store = channel === "email" ? email : whatsapp
  const table = channel === "email" ? "email_messages" : "whatsapp_messages"
  const raw = (messageId = id) =>
    db.all<WorkRow>(
      `SELECT id, state, revision, work_deadline, attempt_id, send_deadline FROM ${table} WHERE id=?`,
      messageId
    )[0]!
  const calls = {
      active: 0,
      admitted: [] as string[],
      observed: [] as string[],
    },
    armed: number[] = [],
    sent: string[] = []
  const emailWork = <A>(stage: string, effect: Effect.Effect<A>) =>
    Effect.suspend(() =>
      failure === stage ? Effect.fail(new EmailUnavailable()) : effect
    )
  const whatsappWork = <A>(stage: string, effect: Effect.Effect<A>) =>
    Effect.suspend(() =>
      failure === stage ? Effect.fail(new WhatsAppUnavailable()) : effect
    )
  const active = Effect.sync(() => {
    calls.active++
    return true
  })
  const arm = (deadline: number) =>
    Effect.sync(() => {
      armed.push(deadline)
    }).pipe(Effect.andThen(Effect.suspend(() => armHook(deadline))))
  const admit = (operationId: string) =>
    Effect.sync(() => {
      calls.admitted.push(operationId)
    })
  const observe = (operationId: string) =>
    Effect.sync(() => {
      calls.observed.push(operationId)
      return undefined
    })
  const send = (text: string) =>
    Effect.sync(() => {
      sent.push(text)
      return `provider-${sent.length}`
    })
  const emailHost: EmailPumpHost = {
    active: () => emailWork("active", active),
    armReply: (deadline) => emailWork("arm", arm(deadline)),
    admit: (input) => emailWork("admit", admit(input.operationId)),
    turn: (operationId) => emailWork("observe", observe(operationId)),
    reviewUrl: () => Effect.succeed("https://pi.example.com/"),
    send: (_record, text) => send(text),
  }
  const whatsappHost: WhatsAppPumpHost = {
    active: () => whatsappWork("active", active),
    armReply: (deadline) => whatsappWork("arm", arm(deadline)),
    admit: (_agent, input) => whatsappWork("admit", admit(input.operationId)),
    turn: (_agent, operationId) =>
      whatsappWork("observe", observe(operationId)),
    name: () => Effect.succeed("Home"),
    reviewUrl: () => "https://pi.example.com/",
    send: (_record, text) => send(text),
  }
  if (channel === "whatsapp")
    await run(
      whatsapp.configure(
        { operationId: crypto.randomUUID(), enabled: true, revision: 0 },
        homeAgentId
      )
    )
  const receive = (messageId: string, deadline = now + REPLY_LEASE_MS) =>
    channel === "email"
      ? run(
          email.receive(
            {
              id: messageId,
              fingerprint: "a".repeat(64),
              messageId: `<${messageId}@example.com>`,
              sender: "owner@example.com",
              recipient: "private@example.com",
              subject: "Deadline",
              body: "Help with dinner.",
              references: "",
            },
            1,
            deadline
          )
        )
      : run(
          whatsapp.receive(
            {
              id: messageId,
              fingerprint: "a".repeat(64),
              messageId: `wamid.${messageId}`,
              threadId: "whatsapp:123456:15550101010",
              sender: "15550101010",
              body: "Help with dinner.",
              timestamp: initialNow,
            },
            homeAgentId,
            {},
            deadline
          )
        )
  await receive(id)
  const prepared = (reply = "", messageId = id) =>
    channel === "email"
      ? email.prepared(messageId, reply)
      : whatsapp.prepared(messageId, reply)
  const claim = (deadline: number) =>
    Effect.gen(function* () {
      const progress: ReplyProgress = {
        version: 1,
        generation: 1,
        parts: [{ text: "Reply", files: [] }],
        receipts: [],
      }
      const lease = { attemptId: "provider-owner", deadline }
      if (channel === "email")
        return yield* email.claim(
          id,
          "Reply",
          () => Effect.succeed(true),
          progress,
          "waiting",
          lease
        )
      const record = yield* whatsapp.get(id)
      return yield* whatsapp.claim(
        record!,
        "Reply",
        () => Effect.succeed(true),
        progress,
        "waiting",
        lease
      )
    })
  return {
    db,
    id,
    table,
    email,
    whatsapp,
    store,
    run,
    raw,
    calls,
    armed,
    sent,
    receive,
    prepared,
    claim,
    pump:
      channel === "email"
        ? emailPump(email, emailHost)
        : whatsappPump(whatsapp, whatsappHost),
    now: () => now,
    advance: (milliseconds: number) => {
      now += milliseconds
    },
    fail: (stage: string) => {
      failure = stage
    },
    holdArm: (work: typeof armHook) => {
      armHook = work
    },
  }
}

describe.each(["email", "whatsapp"] as const)(
  "%s reply work deadlines",
  (channel) => {
    it.each(["queued", "waiting"] as const)(
      "does not revive expired %s work when a fresh inbound message wakes the same pump",
      async (state) => {
        const f = await fixture(channel)
        if (state === "waiting") await f.run(f.prepared())
        const oldDeadline = f.raw().work_deadline
        expect(oldDeadline).toBe(f.now() + REPLY_LEASE_MS)
        f.advance(REPLY_LEASE_MS)
        const freshId = crypto.randomUUID()
        await f.receive(freshId)
        await f.run(f.pump())
        expect(f.raw()).toMatchObject({
          state: "failed",
          work_deadline: oldDeadline,
        })
        expect(f.calls.admitted).toEqual([freshId])
        expect(f.calls.observed).not.toContain(f.id)
        expect(f.raw(freshId).state).toBe("waiting")
        expect(f.sent).toEqual([])
        const publicRecord =
          channel === "email"
            ? await f.run(f.email.get(f.id))
            : await f.run(f.whatsapp.get(f.id))
        expect(publicRecord).not.toHaveProperty("workDeadline")
      }
    )

    it.each(["queued", "waiting"] as const)(
      "refuses %s work with no persisted deadline instead of granting a fresh grace period",
      async (state) => {
        const f = await fixture(channel)
        if (state === "waiting") await f.run(f.prepared())
        f.db.run(`UPDATE ${f.table} SET work_deadline=NULL WHERE id=?`, f.id)
        expect(
          await f.run<ReplyWork | undefined>(f.store.getPendingWork(f.id))
        ).toBeUndefined()
        expect(f.raw()).toMatchObject({
          state: "failed",
          work_deadline: null,
        })
        await f.run(f.pump())
        expect(f.calls).toEqual({ active: 0, admitted: [], observed: [] })
        expect(f.sent).toEqual([])
      }
    )

    it.each(["queued", "waiting"] as const)(
      "gives an explicit %s retry a new deadline but never extends it by replaying its receipt",
      async (state) => {
        const f = await fixture(channel)
        if (state === "waiting") await f.run(f.prepared("A prepared reply."))
        f.advance(REPLY_LEASE_MS)
        await f.run<ReplyWork | undefined>(f.store.getPendingWork(f.id))
        expect(f.raw().state).toBe("failed")
        const operationId = crypto.randomUUID(),
          deadline = f.now() + REPLY_LEASE_MS
        await f.run(f.store.retry(f.id, false, operationId, deadline))
        const accepted = f.raw()
        expect(accepted).toMatchObject({ state, work_deadline: deadline })
        f.advance(1000)
        await f.run(
          f.store.retry(f.id, false, operationId, f.now() + REPLY_LEASE_MS)
        )
        expect(f.raw()).toEqual(accepted)
        f.advance(REPLY_LEASE_MS)
        await f.run<ReplyWork | undefined>(f.store.getPendingWork(f.id))
        const expired = f.raw()
        expect(expired.state).toBe("failed")
        await f.run(
          f.store.retry(f.id, false, operationId, f.now() + REPLY_LEASE_MS)
        )
        expect(f.raw()).toEqual(expired)
        expect(
          f.db.all<{ count: number }>(
            `SELECT count(*) AS count FROM ${channel}_retries`
          )
        ).toEqual([{ count: 1 }])
      }
    )

    it.each(["active", "admit", "observe", "arm"])(
      "never renews a work deadline after a failed %s pass",
      async (stage) => {
        const f = await fixture(channel)
        if (stage === "observe" || stage === "arm") await f.run(f.prepared())
        const deadline = f.raw().work_deadline!
        f.fail(stage)
        for (let attempt = 0; attempt < 3; attempt++) {
          f.advance(1000)
          await expect(f.run(f.pump())).rejects.toMatchObject({
            _tag:
              channel === "email" ? "EmailUnavailable" : "WhatsAppUnavailable",
          })
          expect(f.raw().work_deadline).toBe(deadline)
        }
        f.advance(deadline - f.now())
        f.fail("")
        const before = structuredClone(f.calls)
        await f.run(f.pump())
        expect(f.raw().state).toBe("failed")
        expect(f.calls).toEqual(before)
        expect(f.sent).toEqual([])
      }
    )

    it("renews a successful pending observation only after its recovery wake is armed", async () => {
      const f = await fixture(channel)
      await f.run(f.prepared())
      const before = f.raw()
      f.advance(1000)
      const entered = Deferred.makeUnsafe<number>(),
        release = Deferred.makeUnsafe<void>()
      f.holdArm((deadline) =>
        Deferred.succeed(entered, deadline).pipe(
          Effect.andThen(Deferred.await(release))
        )
      )
      await f.run(
        Effect.gen(function* () {
          const pending = yield* Effect.forkChild(f.pump())
          const deadline = yield* Deferred.await(entered)
          expect(deadline).toBe(f.now() + REPLY_LEASE_MS)
          expect(f.raw()).toEqual(before)
          yield* Deferred.succeed(release, undefined)
          expect(yield* Fiber.join(pending)).toBe(f.now() + 5000)
        })
      )
      expect(f.raw()).toMatchObject({
        state: "waiting",
        work_deadline: f.now() + REPLY_LEASE_MS,
      })
      expect(f.raw().revision).toBeGreaterThan(before.revision)
      expect(f.calls.observed).toEqual([f.id])
      expect(f.sent).toEqual([])
    })

    it("rejects stale renewal revisions and refuses to revive a deadline that elapsed while arming", async () => {
      const f = await fixture(channel)
      const original = (await f.run<ReplyWork | undefined>(
        f.store.getPendingWork(f.id)
      ))!
      expect(original).toMatchObject({
        state: "queued",
        deadline: f.now() + REPLY_LEASE_MS,
      })
      await f.run(f.prepared())
      expect(
        await f.run(
          f.store.renewWork(f.id, original.revision, f.now() + REPLY_LEASE_MS)
        )
      ).toBe(false)
      const current = (await f.run<ReplyWork | undefined>(
        f.store.getPendingWork(f.id)
      ))!
      expect(current.revision).toBeGreaterThan(original.revision)
      f.advance(1000)
      expect(
        await f.run(
          f.store.renewWork(f.id, current.revision, f.now() + REPLY_LEASE_MS)
        )
      ).toBe(true)
      const renewed = f.raw()
      expect(
        await f.run(
          f.store.renewWork(
            f.id,
            current.revision,
            f.now() + 2 * REPLY_LEASE_MS
          )
        )
      ).toBe(false)
      expect(f.raw()).toEqual(renewed)
      const last = (await f.run<ReplyWork | undefined>(
        f.store.getPendingWork(f.id)
      ))!
      f.advance(last.deadline - f.now())
      expect(
        await f.run(
          f.store.renewWork(f.id, last.revision, f.now() + REPLY_LEASE_MS)
        )
      ).toBe(false)
      expect(
        await f.run<ReplyWork | undefined>(f.store.getPendingWork(f.id))
      ).toBeUndefined()
      expect(f.raw()).toMatchObject({
        state: "failed",
        work_deadline: renewed.work_deadline,
      })
    })

    it("keeps an active provider send owned until its independent send deadline", async () => {
      const f = await fixture(channel)
      await f.run(f.prepared("Reply"))
      const workDeadline = f.raw().work_deadline!,
        sendDeadline = f.now() + 2 * REPLY_LEASE_MS
      expect(await f.run(f.claim(sendDeadline))).toBe(true)
      f.advance(workDeadline - f.now())
      expect(
        await f.run<ReplyWork | undefined>(f.store.getPendingWork(f.id))
      ).toBeUndefined()
      await f.run(f.store.exhaustRecovery(undefined, true))
      await f.run(f.store.exhaustRecovery())
      expect(f.raw()).toMatchObject({
        state: "sending",
        attempt_id: "provider-owner",
        send_deadline: sendDeadline,
      })
      f.advance(sendDeadline - f.now())
      await f.run(f.store.exhaustRecovery(undefined, true))
      expect(f.raw().state).toBe("uncertain")
      expect(f.sent).toEqual([])
    })

    it("checks recovery eligibility once inside the transaction before mutating any rows", async () => {
      const f = await fixture(channel),
        other = crypto.randomUUID()
      await f.receive(other)
      await f.run(f.prepared("", other))
      let eligible = true,
        checks = 0
      const before = [f.raw(), f.raw(other)]
      const entered = Deferred.makeUnsafe<void>(),
        release = Deferred.makeUnsafe<void>()
      await f.run(
        Effect.gen(function* () {
          const writer = yield* Effect.forkChild(
            f.db.transaction(() =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release))
              )
            )
          )
          yield* Deferred.await(entered)
          const recovery = yield* Effect.forkChild(
            f.store.exhaustRecovery(() => {
              checks++
              return eligible
            })
          )
          yield* Effect.yieldNow
          expect(checks).toBe(0)
          eligible = false
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(writer)
          yield* Fiber.join(recovery)
        })
      )
      expect(checks).toBe(1)
      expect([f.raw(), f.raw(other)]).toEqual(before)
      checks = 0
      await f.run(
        f.store.exhaustRecovery(() => {
          checks++
          return checks === 1
        })
      )
      expect(checks).toBe(1)
      expect([f.raw().state, f.raw(other).state]).toEqual(["failed", "failed"])
    })

    it("exhausts only each row's expired work when recovery was armed by a newer message", async () => {
      const f = await fixture(channel),
        waiting = crypto.randomUUID(),
        fresh = crypto.randomUUID()
      await f.receive(waiting)
      await f.run(f.prepared("", waiting))
      f.advance(REPLY_LEASE_MS)
      await f.receive(fresh)
      const live = f.raw(fresh)
      await f.run(f.store.exhaustRecovery(undefined, true))
      expect([f.raw().state, f.raw(waiting).state]).toEqual([
        "failed",
        "failed",
      ])
      expect(f.raw(fresh)).toEqual(live)
      expect(
        await f.run<ReplyWork | undefined>(f.store.getPendingWork(fresh))
      ).toMatchObject({
        state: "queued",
        deadline: live.work_deadline,
      })
    })

    it("retains the SQLite driver cause and rolls back admission after a failed write", async () => {
      const f = await fixture(channel)
      if (channel === "whatsapp")
        f.db.run("UPDATE whatsapp_settings SET last_inbound_at=0 WHERE id=1")
      const rows = () => ({
        messages: f.db.all<Record<string, unknown>>(`SELECT * FROM ${f.table}`),
        settings: f.db.all<Record<string, unknown>>(
          `SELECT * FROM ${channel}_settings`
        ),
      })
      const before = rows()
      f.db.run(
        `CREATE TRIGGER reject_reply_work BEFORE INSERT ON ${f.table}
         BEGIN SELECT RAISE(ABORT, 'reply-work-trigger-sentinel'); END`
      )
      const failure = await f.receive(crypto.randomUUID()).then(
        () => undefined,
        (error: unknown) => error
      )
      expect(failure).toMatchObject({
        _tag:
          channel === "email" ? "EmailStorageError" : "WhatsAppStorageError",
        cause: expect.anything(),
      })
      expect(inspect(failure, { depth: null })).toContain(
        "reply-work-trigger-sentinel"
      )
      expect(rows()).toEqual(before)
    })

    it("persists a notice's own prearmed deadline without renewing its parent", async () => {
      const f = await fixture(channel)
      await f.run(f.prepared())
      const before = f.raw()
      f.advance(1000)
      const deadline = f.now() + REPLY_LEASE_MS
      if (channel === "email") {
        const parent = (await f.run(f.email.get(f.id)))!
        await f.run(
          f.email.notice(parent, "approval", "Review in Pi.", deadline)
        )
      } else {
        const parent = (await f.run(f.whatsapp.get(f.id)))!
        await f.run(
          f.whatsapp.notice(
            parent,
            {
              id: crypto.randomUUID(),
              fingerprint: "b".repeat(64),
              messageId: "wamid.approval",
              threadId: parent.threadId,
              sender: parent.sender,
              body: "Approval notification",
              timestamp: parent.timestamp,
            },
            "Review in Pi.",
            deadline
          )
        )
      }
      const notices = f.db.all<WorkRow>(
        `SELECT id, state, work_deadline FROM ${f.table} WHERE id<>?`,
        f.id
      )
      expect(notices).toHaveLength(1)
      expect(notices[0]).toMatchObject({
        state: "waiting",
        work_deadline: deadline,
      })
      expect(f.raw()).toEqual(before)
    })
  }
)

it("persists migration grace once and retains deadlines and receipts across a SQLite reconnect", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reply-work-deadline-")),
    filename = join(directory, "database.sqlite"),
    migrationIndex = agentMigrationManifest.versions.findIndex(
      (version) => version.id === "20261023101342_ambitious_hardball"
    )
  expect(migrationIndex).toBeGreaterThan(0)
  const states = [
    "queued",
    "waiting",
    "sending",
    "uncertain",
    "sent",
    "failed",
    "cancelled",
  ] as const
  const delivery: ReplyProgress = {
    version: 1,
    generation: 1,
    parts: [
      { text: "first", files: [] },
      { text: "second", files: [] },
    ],
    receipts: ["provider-first"],
  }
  const completed: ReplyProgress = {
    ...delivery,
    receipts: ["provider-first", "provider-second"],
  }
  const ids = new Map<string, string>()
  try {
    const seed = new DatabaseSync(filename)
    try {
      for (const version of agentMigrationManifest.versions.slice(
        0,
        migrationIndex
      )) {
        for (const statement of version.statements) seed.exec(statement)
        seed
          .prepare(
            "INSERT INTO __durable_pi_migrations (id, checksum) VALUES (?, ?)"
          )
          .run(version.id, version.checksum)
      }
      for (const channel of ["email", "whatsapp"] as const)
        for (const state of [
          ...states,
          ...(channel === "whatsapp" ? ["expired"] : []),
        ]) {
          const id = crypto.randomUUID()
          ids.set(`${channel}:${state}`, id)
          const progress =
            state === "sent"
              ? JSON.stringify(completed)
              : ["sending", "uncertain"].includes(state)
                ? JSON.stringify(delivery)
                : null
          if (channel === "email")
            seed
              .prepare(
                `INSERT INTO email_messages
                (id, fingerprint, message_id, sender, recipient, subject, body, "references", state, created_at, delivery, attempt_id, send_deadline)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
              )
              .run(
                id,
                "a".repeat(64),
                id,
                "owner@example.com",
                "private@example.com",
                "Retained",
                "Request",
                "",
                state,
                1,
                progress,
                state === "sending" ? "saved-owner" : null,
                state === "sending" ? 9_000_000_000_000 : null
              )
          else
            seed
              .prepare(
                `INSERT INTO whatsapp_messages
                (id, fingerprint, message_id, thread_id, sender, body, timestamp, agent_id, generation, control, state, created_at, delivery, attempt_id, send_deadline)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
              )
              .run(
                id,
                "a".repeat(64),
                id,
                "whatsapp:123456:15550101010",
                "15550101010",
                "Request",
                1,
                homeAgentId,
                1,
                0,
                state,
                1,
                progress,
                state === "sending" ? "saved-owner" : null,
                state === "sending" ? 9_000_000_000_000 : null
              )
          if (state === "uncertain")
            seed
              .prepare(
                `INSERT INTO ${channel}_retries
                (operation_id, ${channel === "email" ? "email_id" : "message_id"}, acknowledge_duplicate_risk)
                VALUES (?, ?, 1)`
              )
              .run(`saved-${channel}-retry`, id)
        }
    } finally {
      seed.close()
    }
    const before = Date.now()
    const first = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const db = yield* makeNodeSqlite({ filename })
          yield* migrateSqlite(db, { audit: true })
          return {
            email: yield* db.use((orm) => orm.select().from(emailMessages)),
            whatsapp: yield* db.use((orm) =>
              orm.select().from(whatsappMessages)
            ),
            emailRetries: yield* db.use((orm) =>
              orm.select().from(emailRetries)
            ),
            whatsappRetries: yield* db.use((orm) =>
              orm.select().from(whatsappRetries)
            ),
          }
        })
      )
    )
    const after = Date.now()
    for (const channel of ["email", "whatsapp"] as const)
      for (const row of first[channel]) {
        expect(row.id).toBe(ids.get(`${channel}:${row.state}`))
        if (["queued", "waiting"].includes(row.state)) {
          expect(row.workDeadline).toBeGreaterThanOrEqual(
            before + REPLY_LEASE_MS - 1
          )
          expect(row.workDeadline).toBeLessThanOrEqual(
            after + REPLY_LEASE_MS + 1
          )
        } else expect(row.workDeadline).toBeNull()
        expect(row.delivery).toEqual(
          row.state === "sent"
            ? completed
            : ["sending", "uncertain"].includes(row.state)
              ? delivery
              : null
        )
      }
    expect(first.emailRetries).toHaveLength(1)
    expect(first.whatsappRetries).toHaveLength(1)
    const expiredAt = Math.max(
      ...[...first.email, ...first.whatsapp].map((row) => row.workDeadline ?? 0)
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const db = yield* makeNodeSqlite({ filename })
          yield* migrateSqlite(db, { audit: true })
          const restored = {
            email: yield* db.use((orm) => orm.select().from(emailMessages)),
            whatsapp: yield* db.use((orm) =>
              orm.select().from(whatsappMessages)
            ),
            emailRetries: yield* db.use((orm) =>
              orm.select().from(emailRetries)
            ),
            whatsappRetries: yield* db.use((orm) =>
              orm.select().from(whatsappRetries)
            ),
          }
          expect(restored).toEqual(first)
          for (const channel of ["email", "whatsapp"] as const) {
            const store =
              channel === "email" ? new EmailStore(db) : new WhatsAppStore(db)
            for (const state of ["queued", "waiting"] as const) {
              const id = ids.get(`${channel}:${state}`)!
              expect(yield* store.getPendingWork(id)).toBeUndefined()
              expect((yield* store.get(id))?.state).toBe("failed")
            }
            expect(
              (yield* store.get(ids.get(`${channel}:sending`)!))?.state
            ).toBe("sending")
            expect(
              (yield* store.get(ids.get(`${channel}:uncertain`)!))?.delivery
            ).toEqual(delivery)
          }
        })
      ).pipe(
        Effect.provideService(
          Clock.Clock,
          fixtureClock(() => expiredAt)
        )
      )
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
