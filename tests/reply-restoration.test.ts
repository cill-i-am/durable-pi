import { Deferred, Effect } from "effect"
import { describe, expect, it } from "vitest"

import { homeAgentId } from "../src/agents/domain"
import { EmailStore } from "../src/email/adapters/sqlite"
import { REPLY_LEASE_MS } from "../src/replies/contracts"
import { agentMigrationManifest } from "../src/storage/migration-manifest"
import { migrateSqlite } from "../src/storage/migrations"
import { WhatsAppStore } from "../src/whatsapp/adapters/sqlite"
import { WhatsAppRejected } from "../src/whatsapp/contracts"
import { whatsappPump } from "../src/whatsapp/pump"
import { database } from "./database"
import { imageMetadata } from "./image-fixture"

const run = <A>(work: Effect.Effect<A, unknown>) => Effect.runPromise(work)
const progress = {
  version: 1,
  generation: 1,
  parts: [{ text: "Saved", files: [] }],
  receipts: ["confirmed"],
}
describe("reply data restoration", () => {
  it("adds ownership without rewriting legacy identities, plans, receipts or retry acknowledgements", () => {
    const db = database({ migrate: false })
    for (const version of agentMigrationManifest.versions.slice(
      0,
      agentMigrationManifest.versions.findIndex(
        (entry) => entry.id === "20261023082234_blushing_havok"
      )
    )) {
      for (const statement of version.statements) db.run(statement)
      db.run(
        "INSERT INTO __durable_pi_migrations VALUES (?,?)",
        version.id,
        version.checksum
      )
    }
    for (const channel of ["email", "whatsapp"]) {
      for (const state of [
        "queued",
        "waiting",
        "sending",
        "sent",
        "failed",
        "uncertain",
        "cancelled",
        ...(channel === "whatsapp" ? ["expired"] : []),
      ]) {
        const id = crypto.randomUUID()
        if (channel === "email")
          db.run(
            'INSERT INTO email_messages(id,fingerprint,message_id,sender,recipient,subject,body,"references",state,reply,delivery,provider_id,error,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            id,
            "a".repeat(64),
            `<${id}@example.com>`,
            "owner@example.com",
            "private@example.com",
            "Legacy",
            "STATUS",
            "",
            state,
            "Saved",
            JSON.stringify(progress),
            "confirmed",
            "kept error",
            1
          )
        else
          db.run(
            "INSERT INTO whatsapp_messages(id,fingerprint,message_id,thread_id,sender,body,timestamp,agent_id,generation,control,state,reply,delivery,provider_id,error,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            id,
            "a".repeat(64),
            `wamid.${id}`,
            "whatsapp:123456:15550101010",
            "15550101010",
            "STATUS",
            Date.now(),
            homeAgentId,
            1,
            0,
            state,
            "Saved",
            JSON.stringify(progress),
            "confirmed",
            "kept error",
            1
          )
        if (state === "failed")
          db.run(
            `INSERT INTO ${channel}_retries VALUES (?,?,?)`,
            crypto.randomUUID(),
            id,
            1
          )
      }
    }
    const before = new Map(
      ["email", "whatsapp"].map((channel) => [
        channel,
        {
          rows: db.all<Record<string, unknown>>(
            `SELECT * FROM ${channel}_messages ORDER BY id`
          ),
          retries: db.all(`SELECT * FROM ${channel}_retries`),
        },
      ])
    )
    Effect.runSync(migrateSqlite(db, { audit: true }))
    Effect.runSync(migrateSqlite(db, { audit: true }))
    for (const channel of ["email", "whatsapp"]) {
      const old = before.get(channel)!
      expect(db.all(`SELECT * FROM ${channel}_messages ORDER BY id`)).toEqual(
        old.rows.map((row) => ({
          ...row,
          schemaVersion: 1,
          workflowVersion: 1,
          revision: 0,
          attempt_id: null,
          send_index: null,
          send_deadline: null,
          work_deadline: ["queued", "waiting"].includes(String(row.state))
            ? expect.any(Number)
            : null,
        }))
      )
      expect(db.all(`SELECT * FROM ${channel}_retries`)).toEqual(old.retries)
      const store =
        channel === "email" ? new EmailStore(db) : new WhatsAppStore(db)
      Effect.runSync<void, unknown>(store.recover(false))
      const sending = old.rows.find((row) => row.state === "sending")!
      const restored = db.all<{ state: string; provider_id: string }>(
        `SELECT state,provider_id FROM ${channel}_messages WHERE id=?`,
        String(sending.id)
      )[0]!
      expect(restored).toEqual({ state: "sent", provider_id: "confirmed" })
      db.run(
        `UPDATE ${channel}_messages SET state='sending',delivery=NULL WHERE id=?`,
        String(sending.id)
      )
      Effect.runSync<void, unknown>(store.recover(false))
      expect(
        db.all<{ state: string }>(
          `SELECT state FROM ${channel}_messages WHERE id=?`,
          String(sending.id)
        )[0]!.state
      ).toBe("uncertain")
    }
  })
  it.each(["email", "whatsapp"] as const)(
    "refuses incompatible %s data without rewriting it",
    async (channel) => {
      const db = database(),
        email = new EmailStore(db),
        whatsapp = new WhatsAppStore(db)
      const id = crypto.randomUUID()
      if (channel === "email")
        await run(
          email.receive(
            {
              id,
              fingerprint: "a".repeat(64),
              messageId: "<restore@example.com>",
              sender: "owner@example.com",
              recipient: "private@example.com",
              subject: "Restore",
              body: "Reply",
              references: "",
            },
            1,
            Date.now() + REPLY_LEASE_MS
          )
        )
      else {
        await run(
          whatsapp.configure(
            { operationId: crypto.randomUUID(), enabled: true, revision: 0 },
            homeAgentId
          )
        )
        await run(
          whatsapp.receive(
            {
              id,
              fingerprint: "a".repeat(64),
              messageId: "wamid.restore",
              sender: "15550101010",
              threadId: "whatsapp:123456:15550101010",
              body: "Reply",
              timestamp: Date.now(),
            },
            homeAgentId,
            {},
            Date.now() + REPLY_LEASE_MS
          )
        )
      }
      const store = channel === "email" ? email : whatsapp
      for (const field of ["schemaVersion", "workflowVersion"]) {
        db.run(`UPDATE ${channel}_messages SET ${field}=2`)
        const before = db.all(`SELECT * FROM ${channel}_messages`)
        await expect(run(store.recover())).rejects.toThrow(field)
        expect(db.all(`SELECT * FROM ${channel}_messages`)).toEqual(before)
        db.run(`UPDATE ${channel}_messages SET ${field}=1`)
      }
    }
  )
})

describe("held WhatsApp media completion", () => {
  it.each(["complete", "reject"] as const)(
    "fences an obsolete import that later chooses to %s",
    async (result) => {
      const db = database(),
        store = new WhatsAppStore(db)
      await run(
        store.configure(
          { operationId: crypto.randomUUID(), enabled: true, revision: 0 },
          homeAgentId
        )
      )
      const id = crypto.randomUUID()
      await run(
        store.receive(
          {
            id,
            fingerprint: "a".repeat(64),
            messageId: "wamid.held",
            sender: "15550101010",
            threadId: "whatsapp:123456:15550101010",
            body: "Describe",
            timestamp: Date.now(),
            media: imageMetadata,
          },
          homeAgentId,
          {},
          Date.now() + REPLY_LEASE_MS
        )
      )
      const started = Deferred.makeUnsafe<void>(),
        release = Deferred.makeUnsafe<void>()
      const admitted: string[][] = []
      let calls = 0
      const pump = whatsappPump(store, {
        armReply: () => Effect.void,
        active: () => Effect.succeed(true),
        name: () => Effect.succeed("Home"),
        reviewUrl: () => "https://pi.example/",
        turn: () => Effect.succeed(undefined),
        send: () => Effect.succeed("unused"),
        admit: (_agent, input) =>
          Effect.sync(() => {
            admitted.push([...(input.files ?? [])])
          }),
        media: () =>
          Effect.gen(function* () {
            calls++
            if (calls === 1) {
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(release)
              if (result === "reject")
                return yield* new WhatsAppRejected({
                  message: "Late rejection",
                })
              return "11111111-1111-4111-8111-111111111111"
            }
            return "22222222-2222-4222-8222-222222222222"
          }),
      })
      const older = run(pump())
      await run(Deferred.await(started))
      // A second pass owns a newer revision while the first import is held.
      await run(pump())
      const current = await run(store.get(id))
      expect(current).toMatchObject({
        state: "waiting",
        fileId: "22222222-2222-4222-8222-222222222222",
      })
      expect(admitted).toEqual([["22222222-2222-4222-8222-222222222222"]])
      await run(Deferred.succeed(release, undefined))
      await older
      expect(await run(store.get(id))).toEqual(current)
      expect(admitted).toEqual([["22222222-2222-4222-8222-222222222222"]])
    }
  )
})
