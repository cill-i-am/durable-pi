import type { Sqlite } from "../../storage/sqlite"
import type { RoutineStore } from "../../routines/adapters/sqlite"
import { type ConfigureWebhook, type WebhookInfo, reject } from "../contracts"

type KeyRow = { revision: number; hash: string | null }
/** Owns only inbound authority and receipts. RoutineStore owns run execution. */
export class WebhookStore {
  constructor(
    private readonly db: Sqlite,
    private readonly routines: RoutineStore,
    private readonly active: () => boolean
  ) {
    db.run(
      "CREATE TABLE IF NOT EXISTS webhooks (routine_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, hash TEXT)"
    )
    db.run(
      "CREATE TABLE IF NOT EXISTS webhook_operations (id TEXT PRIMARY KEY, input TEXT NOT NULL, result TEXT NOT NULL)"
    )
    db.run(
      "CREATE TABLE IF NOT EXISTS webhook_events (routine_id TEXT NOT NULL,event_id TEXT NOT NULL,hash TEXT NOT NULL,run_id TEXT NOT NULL, PRIMARY KEY(routine_id,event_id))"
    )
  }
  private row(id: string) {
    return this.db.all<KeyRow>(
      "SELECT revision,hash FROM webhooks WHERE routine_id=?",
      id
    )[0]
  }
  info(id: string): WebhookInfo {
    const row = this.row(id)
    return {
      routineId: id,
      enabled: !!row?.hash,
      revision: row?.revision ?? 0,
      accepted: this.db.all<{ n: number }>(
        "SELECT count(*) AS n FROM webhook_events WHERE routine_id=?",
        id
      )[0]!.n,
    }
  }
  configure(input: Omit<ConfigureWebhook, "key"> & { hash: string | null }) {
    return this.db.transaction(() => {
      if (!this.active())
        reject(409, "Restore this bot before changing its webhook.")
      const routine = this.routines.get(input.routineId)
      if (!routine || routine.status === "archived")
        reject(409, "Restore this routine before changing its webhook.")
      const previous = this.db.all<{ input: string; result: string }>(
        "SELECT input,result FROM webhook_operations WHERE id=?",
        input.operationId
      )[0]
      if (previous) {
        if (previous.input !== JSON.stringify(input))
          reject(
            409,
            "This request was cancelled or belongs to another change."
          )
        return JSON.parse(previous.result) as WebhookInfo
      }
      if (
        this.db.all<{ n: number }>(
          "SELECT count(*) AS n FROM webhook_operations"
        )[0]!.n >= 2000
      )
        reject(409, "This bot reached its webhook change limit.")
      const current = this.row(input.routineId)
      if ((current?.revision ?? 0) !== input.expectedRevision)
        reject(
          409,
          "The webhook changed. Resolve this request and reload before changing it."
        )
      this.db.run(
        "INSERT INTO webhooks VALUES (?,?,?) ON CONFLICT(routine_id) DO UPDATE SET revision=excluded.revision,hash=excluded.hash",
        input.routineId,
        input.expectedRevision + 1,
        input.hash
      )
      // Revoking or rotating a key also cancels its unadmitted work.
      const pending = this.routines.inFlight()
      if (
        pending?.routineId === input.routineId &&
        pending.trigger === "webhook" &&
        pending.status === "pending"
      )
        this.routines.cancelPendingRun(pending.id)
      const info = this.info(input.routineId)
      this.db.run(
        "INSERT INTO webhook_operations VALUES (?,?,?)",
        input.operationId,
        JSON.stringify(input),
        JSON.stringify(info)
      )
      return info
    })
  }
  cancel(operationId: string) {
    return this.db.transaction(() => {
      if (!this.active()) reject(409, "Restore this bot first.")
      const previous = this.db.all<{ input: string }>(
        "SELECT input FROM webhook_operations WHERE id=?",
        operationId
      )[0]
      if (previous) return { applied: previous.input !== "cancelled" }
      if (
        this.db.all<{ n: number }>(
          "SELECT count(*) AS n FROM webhook_operations"
        )[0]!.n >= 2000
      )
        reject(409, "This bot reached its webhook change limit.")
      this.db.run(
        "INSERT INTO webhook_operations VALUES (?,'cancelled','null')",
        operationId
      )
      return { applied: false }
    })
  }
  authorized(id: string, hash: string) {
    const expected = this.row(id)?.hash ?? "0".repeat(64)
    let diff = expected.length ^ hash.length
    for (let i = 0; i < 64; i++)
      diff |= expected.charCodeAt(i) ^ (hash.charCodeAt(i) || 0)
    return !!this.row(id)?.hash && diff === 0 && this.active()
  }
  accept(
    id: string,
    keyHash: string,
    eventId: string,
    payload: string,
    payloadHash: string
  ) {
    return this.db.transaction(() => {
      if (!this.authorized(id, keyHash))
        reject(401, "Invalid webhook authorization.")
      const previous = this.db.all<{ hash: string; run_id: string }>(
        "SELECT hash,run_id FROM webhook_events WHERE routine_id=? AND event_id=?",
        id,
        eventId
      )[0]
      if (previous) {
        if (previous.hash !== payloadHash)
          reject(409, "This event ID already belongs to different data.")
        return { runId: previous.run_id, duplicate: true }
      }
      if (this.routines.get(id)?.status !== "active")
        reject(409, "This routine is paused or unavailable.")
      if (this.routines.inFlight())
        reject(
          429,
          "This bot already has a routine waiting or running. Retry this event later."
        )
      if (
        this.db.all<{ n: number }>(
          "SELECT count(*) AS n FROM webhook_events"
        )[0]!.n >= 2000
      )
        reject(409, "This bot reached its webhook event limit.")
      const run = this.routines.acceptWebhook(id, payload)
      this.db.run(
        "INSERT INTO webhook_events VALUES (?,?,?,?)",
        id,
        eventId,
        payloadHash,
        run.id
      )
      return { runId: run.id, duplicate: false }
    })
  }
}
