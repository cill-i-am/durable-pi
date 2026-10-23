import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import type { ExecutableEffect } from "xstate"

import { AgentId, homeAgentId } from "../src/agents/domain"
import { EmailStore } from "../src/email/adapters/sqlite"
import {
  configureEmail,
  emailConfigurationCommands,
  readEmailConfiguration,
} from "../src/email/configuration.machine"
import type { ConfigureEmail } from "../src/email/contracts"
import { agentMigrationManifest } from "../src/storage/migration-manifest"
import { migrateSqlite } from "../src/storage/migrations"
import { WhatsAppStore } from "../src/whatsapp/adapters/sqlite"
import {
  advanceWhatsAppConfiguration,
  readWhatsAppConfiguration,
  whatsappConfigurationCommands,
} from "../src/whatsapp/configuration.machine"
import { database } from "./database"
import { run } from "./routine-fixture"

const child = Schema.decodeUnknownSync(AgentId)(
  "12345678-1234-4234-8234-123456789abc"
)
const operation = (revision: number, enabled: boolean): ConfigureEmail => ({
  operationId: crypto.randomUUID(),
  revision,
  enabled,
})
function fixture(channel: "email" | "whatsapp") {
  const db = database(),
    email = new EmailStore(db),
    whatsapp = new WhatsAppStore(db)
  const configure = (input: ConfigureEmail, route = homeAgentId) =>
    channel === "email"
      ? run(email.configure(input))
      : run(whatsapp.configure(input, route))
  const settings = () =>
    channel === "email" ? run(email.settings()) : run(whatsapp.settings())
  const receive = () => {
    const id = crypto.randomUUID()
    const input = {
      id,
      fingerprint: "a".repeat(64),
      body: "Preserve this request.",
    }
    if (channel === "email")
      run(
        email.receive(
          {
            ...input,
            messageId: `<${id}@example.com>`,
            sender: "owner@example.com",
            recipient: "private@example.com",
            subject: "Configuration",
            references: "",
          },
          settings().generation,
          Date.now() + 60_000
        )
      )
    else
      run(
        whatsapp.receive(
          {
            ...input,
            messageId: `wamid.${id}`,
            sender: "15550101010",
            threadId: "whatsapp:123456:15550101010",
            timestamp: Date.now(),
          },
          homeAgentId,
          {},
          Date.now() + 60_000
        )
      )
    return id
  }
  const rows = () =>
    db.all<Record<string, unknown>>(
      `SELECT * FROM ${channel}_messages ORDER BY created_at`
    )
  const stored = () => db.all(`SELECT * FROM ${channel}_settings`)
  return { db, email, whatsapp, configure, settings, receive, rows, stored }
}

describe.each(["email", "whatsapp"] as const)("%s configuration", (channel) => {
  it("preserves empty-store defaults, exact replay and revision/generation boundaries", () => {
    const f = fixture(channel)
    const defaults = {
      enabled: channel === "email",
      revision: 0,
      generation: channel === "email" ? 1 : 0,
      operationId: "",
      ...(channel === "email"
        ? {}
        : { agentId: homeAgentId, lastInboundAt: 0 }),
    }
    expect(f.settings()).toEqual(defaults)
    expect(f.stored()).toEqual([])
    const first = operation(0, true)
    expect(f.configure(first)).toEqual({
      ...defaults,
      enabled: true,
      revision: 1,
      generation: 1,
      operationId: first.operationId,
    })
    const saved = f.stored()
    expect(f.configure(first)).toEqual(f.settings())
    expect(f.stored()).toEqual(saved)
    for (const conflicting of [
      { ...first, enabled: false },
      { ...first, revision: 1 },
      operation(0, false),
    ]) {
      expect(() => f.configure(conflicting)).toThrow()
      expect(f.stored()).toEqual(saved)
    }
    if (channel === "whatsapp") {
      expect(() => f.configure(first, child)).toThrow()
      expect(f.stored()).toEqual(saved)
    }
    expect(f.configure(operation(1, true))).toMatchObject({
      revision: 2,
      generation: 1,
    })
    expect(f.configure(operation(2, false))).toMatchObject({
      enabled: false,
      revision: 3,
      generation: 1,
    })
    expect(f.configure(operation(3, false))).toMatchObject({
      enabled: false,
      revision: 4,
      generation: 1,
    })
    expect(f.configure(operation(4, true))).toMatchObject({
      enabled: true,
      revision: 5,
      generation: 2,
    })
    expect(f.settings()).not.toHaveProperty("schemaVersion")
    expect(f.stored()).toMatchObject([{ schemaVersion: 1, workflowVersion: 1 }])
  })

  it("cancels only queued/waiting replies in the same configuration commit, preserving a live sender", () => {
    const f = fixture(channel)
    f.configure(operation(0, true))
    for (const [i, state] of [
      "queued",
      "waiting",
      "sending",
      "failed",
    ].entries()) {
      const id = f.receive()
      f.db.run(
        `UPDATE ${channel}_messages SET state=?,created_at=? WHERE id=?`,
        state,
        i,
        id
      )
      if (state === "sending")
        f.db.run(
          `UPDATE ${channel}_messages SET attempt_id='existing-owner',send_deadline=?,send_index=0 WHERE id=?`,
          Date.now() + 60_000,
          id
        )
    }
    const before = f.rows()
    const disable = operation(1, false)
    f.configure(disable)
    const after = f.rows()
    expect(after.map((row) => row.state)).toEqual([
      "cancelled",
      "cancelled",
      "sending",
      "failed",
    ])
    expect(after[2]).toEqual(before[2])
    expect(after[3]).toEqual(before[3])
    for (const row of after.slice(0, 2)) {
      expect(row.revision).toBe(1)
      expect(row.error).toContain("disabled")
    }
    f.configure(disable)
    expect(f.rows()).toEqual(after)
  })

  it("rolls back configuration, receipt and every cancellation when any pending write fails", () => {
    const f = fixture(channel)
    f.configure(operation(0, true))
    const first = f.receive(),
      second = f.receive()
    f.db.run(`UPDATE ${channel}_messages SET created_at=1 WHERE id=?`, first)
    f.db.run(`UPDATE ${channel}_messages SET created_at=2 WHERE id=?`, second)
    f.db.run(
      `CREATE TRIGGER fail_cancel BEFORE UPDATE ON ${channel}_messages WHEN NEW.id='${second}' AND NEW.state='cancelled' BEGIN SELECT RAISE(ABORT,'held cancellation fault'); END`
    )
    const before = f.rows(),
      settings = f.stored(),
      disable = operation(1, false)
    expect(() => f.configure(disable)).toThrow()
    expect(f.stored()).toEqual(settings)
    expect(f.rows()).toEqual(before)
    f.db.run("DROP TRIGGER fail_cancel")
    f.configure(disable)
    expect(f.rows().map((row) => row.state)).toEqual(["cancelled", "cancelled"])
    expect(f.settings()).toMatchObject({
      revision: 2,
      enabled: false,
      operationId: disable.operationId,
    })
  })

  it.each(["schemaVersion", "workflowVersion"])(
    "refuses incompatible %s without mutation or partial cancellation",
    (field) => {
      const f = fixture(channel)
      f.configure(operation(0, true))
      f.receive()
      f.db.run(`UPDATE ${channel}_settings SET ${field}=2`)
      const settings = f.stored(),
        messages = f.rows()
      expect(() => f.settings()).toThrow()
      expect(() => f.configure(operation(1, false))).toThrow()
      expect(f.stored()).toEqual(settings)
      expect(f.rows()).toEqual(messages)
    }
  )
})

describe("WhatsApp route admission", () => {
  it("commits route revision with the message, invalidates the old configure receipt and does not reapply redelivery", () => {
    const f = fixture("whatsapp"),
      configure = operation(0, true)
    f.configure(configure)
    const input = {
      id: crypto.randomUUID(),
      fingerprint: "a".repeat(64),
      body: `/agent ${child}`,
      messageId: "wamid.route",
      sender: "15550101010",
      threadId: "whatsapp:123456:15550101010",
      timestamp: Date.now(),
    }
    run(
      f.whatsapp.receive(
        input,
        child,
        { route: child, generation: 1 },
        Date.now() + 60_000
      )
    )
    expect(f.settings()).toMatchObject({
      agentId: child,
      revision: 2,
      generation: 1,
      operationId: "",
      lastInboundAt: input.timestamp,
    })
    expect(() => f.configure(configure)).toThrow()
    expect(() => f.configure(operation(1, false))).toThrow()
    expect(
      run(
        f.whatsapp.receive(
          input,
          child,
          { route: child, generation: 1 },
          Date.now() + 60_000
        )
      )
    ).toBe(false)
    expect(f.settings().revision).toBe(2)
    run(
      f.whatsapp.receive(
        {
          ...input,
          id: crypto.randomUUID(),
          messageId: "wamid.older",
          timestamp: input.timestamp - 1000,
        },
        child,
        {},
        Date.now() + 60_000
      )
    )
    expect(f.settings()).toMatchObject({
      revision: 2,
      lastInboundAt: input.timestamp,
    })
    f.configure(operation(2, true), child)
    expect(f.settings()).toMatchObject({
      revision: 3,
      generation: 1,
      lastInboundAt: input.timestamp,
    })
  })

  it("rolls back route, last-inbound timestamp and revision if message acceptance fails", () => {
    const f = fixture("whatsapp")
    f.configure(operation(0, true))
    const before = f.stored()
    f.db.run(
      "CREATE TRIGGER fail_message BEFORE INSERT ON whatsapp_messages BEGIN SELECT RAISE(ABORT,'message fault'); END"
    )
    expect(() =>
      run(
        f.whatsapp.receive(
          {
            id: crypto.randomUUID(),
            fingerprint: "b".repeat(64),
            body: `/agent ${child}`,
            messageId: "wamid.route",
            sender: "15550101010",
            threadId: "whatsapp:123456:15550101010",
            timestamp: Date.now(),
          },
          child,
          { route: child, generation: 1 },
          Date.now() + 60_000
        )
      )
    ).toThrow()
    expect(f.stored()).toEqual(before)
    expect(f.rows()).toEqual([])
  })
})

describe("channel configuration reconstruction", () => {
  it.each([false, true])(
    "migrates legacy enabled=%s rows without rewriting settings or operation identities",
    (enabled) => {
      const db = database({ migrate: false })
      const index = agentMigrationManifest.versions.findIndex((version) =>
        version.statements.some((statement) =>
          statement.includes("ALTER TABLE `email_settings` ADD `schemaVersion`")
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
      const receipt = crypto.randomUUID()
      db.run(
        "INSERT INTO email_settings(id,enabled,revision,generation,operation_id) VALUES (1,?,7,3,?)",
        Number(enabled),
        receipt
      )
      db.run(
        "INSERT INTO whatsapp_settings(id,enabled,agent_id,revision,generation,operation_id,last_inbound_at) VALUES (1,?,?,7,3,?,123456)",
        Number(enabled),
        child,
        receipt
      )
      const before = ["email", "whatsapp"].map((channel) =>
        db.all<Record<string, unknown>>(`SELECT * FROM ${channel}_settings`)
      )
      Effect.runSync(migrateSqlite(db, { audit: true }))
      Effect.runSync(migrateSqlite(db, { audit: true }))
      for (const [i, channel] of ["email", "whatsapp"].entries())
        expect(db.all(`SELECT * FROM ${channel}_settings`)).toEqual(
          before[i]!.map((row) => ({
            ...row,
            schemaVersion: 1,
            workflowVersion: 1,
          }))
        )
      expect(
        run(
          new EmailStore(db).configure({
            operationId: receipt,
            revision: 6,
            enabled,
          })
        )
      ).toMatchObject({ revision: 7, generation: 3 })
      expect(
        run(
          new WhatsAppStore(db).configure(
            { operationId: receipt, revision: 6, enabled },
            child
          )
        )
      ).toMatchObject({ revision: 7, generation: 3, lastInboundAt: 123456 })
    }
  )

  it("rejects malformed events and executable descriptors rather than ignoring them", () => {
    const email = readEmailConfiguration(undefined),
      whatsapp = readWhatsAppConfiguration(undefined)
    expect(() =>
      configureEmail(email, {
        ...operation(0, false),
        enabled: "false",
      } as never)
    ).toThrow()
    expect(() =>
      advanceWhatsAppConfiguration(whatsapp, {
        type: "CONFIGURE",
        ...operation(0, true),
        agentId: "invalid",
      } as never)
    ).toThrow()
    expect(() =>
      advanceWhatsAppConfiguration(whatsapp, {
        type: "INBOUND",
        timestamp: -1,
        route: null,
      })
    ).toThrow()
    for (const commands of [
      emailConfigurationCommands,
      whatsappConfigurationCommands,
    ])
      expect(() =>
        commands([{ type: "@xstate.spawnChild" } as ExecutableEffect])
      ).toThrow()
    expect(readEmailConfiguration(JSON.parse(JSON.stringify(email)))).toEqual(
      email
    )
    expect(
      readWhatsAppConfiguration(JSON.parse(JSON.stringify(whatsapp)))
    ).toEqual(whatsapp)
  })
})
