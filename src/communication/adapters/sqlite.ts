import { Effect, Layer, Schema } from "effect"
import type { Sqlite } from "../../storage/sqlite"
import { Mailbox } from "../mailbox"
import {
  CommunicationError,
  Delivery,
  Envelope,
  Identity,
  Outcome,
  Receipt,
  Task,
  canonicalEnvelope,
  failure,
  isRequest,
  terminal,
  LEASE_MS,
  MAX_ATTEMPTS,
  MAX_OPEN_TASKS,
  MAX_RECORDS,
  MAX_TASK_MS,
  RESULT_WINDOW_MS,
} from "../contracts"

const DeliveryJson = Schema.fromJsonString(Delivery)
const TaskJson = Schema.fromJsonString(Task)
const ReceiptJson = Schema.fromJsonString(Receipt)
const EnvelopeJson = Schema.fromJsonString(Envelope)
const IdentityJson = Schema.fromJsonString(Identity)

export function sqliteMailbox(db: Sqlite) {
  const atomic = <T>(body: () => T) =>
    Effect.try({
      try: () => db.transaction(body),
      catch: (error) =>
        error instanceof CommunicationError
          ? error
          : failure(
              "storage",
              "Mailbox state could not be confirmed. Retry the same operation."
            ),
    })
  const read = (table: string, id: string) =>
    db.all<{ body: string }>(`SELECT body FROM ${table} WHERE id=?`, id)[0]
      ?.body
  const identity = () => {
    const row = read("communication_identity", "self")
    if (!row)
      throw failure("forbidden", "This bot has no communication identity.")
    return Schema.decodeUnknownSync(IdentityJson)(row)
  }
  const delivery = (id: string) => {
    const body = read("communication_outbox", id)
    return body ? Schema.decodeUnknownSync(DeliveryJson)(body) : undefined
  }
  const task = (id: string) => {
    const body = read("communication_tasks", id)
    if (!body) throw failure("not_found", "Task unavailable in this bot.")
    return Schema.decodeUnknownSync(TaskJson)(body)
  }
  const saveDelivery = (d: Delivery) =>
    db.run(
      "INSERT INTO communication_outbox(id,body,status,next_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,status=excluded.status,next_at=excluded.next_at",
      d.envelope.id,
      Schema.encodeSync(DeliveryJson)(d),
      d.status,
      d.nextAt
    )
  const saveTask = (t: Task) =>
    db.run(
      "INSERT INTO communication_tasks(id,body,status,lease_until,deadline,direction) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,status=excluded.status,lease_until=excluded.lease_until",
      t.id,
      Schema.encodeSync(TaskJson)(t),
      t.status,
      t.leaseUntil,
      t.request.deadline,
      t.direction
    )
  const taskSelection =
    "SELECT id FROM communication_tasks ORDER BY CASE WHEN status IN ('accepted','running','waiting','cancelling') OR (direction='outgoing' AND json_extract(body,'$.resumed')=0) THEN 0 ELSE 1 END,rowid DESC LIMIT 100"
  const tasks = () =>
    db
      .all<{ body: string }>(
        `SELECT body FROM communication_tasks WHERE id IN (${taskSelection}) ORDER BY rowid DESC`
      )
      .map((row) => Schema.decodeUnknownSync(TaskJson)(row.body))
  const count = (table: string) =>
    db.all<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)[0]!.n
  const requireSpace = (table: string) => {
    if (
      count(table) >=
      MAX_RECORDS *
        (table === "communication_outbox" || table === "communication_inbox"
          ? 3
          : 1)
    )
      throw failure(
        "limit",
        "This bot's retained mailbox is full. Existing receipts are preserved."
      )
  }
  const check = (e: Envelope) => {
    Schema.decodeUnknownSync(Envelope)(e)
    if (
      e.from === e.to ||
      e.depth !== 1 ||
      e.deadline <= e.createdAt ||
      e.deadline - e.createdAt > (isRequest(e) ? MAX_TASK_MS : RESULT_WINDOW_MS)
    )
      throw failure("invalid", "Invalid delegation bounds.")
    if (isRequest(e) && (e.taskId !== e.id || e.id.length > 160))
      throw failure("invalid", "Request and task identities must match.")
  }
  const sameTask = (e: Envelope, t: Task, reverse: boolean) => {
    if (
      e.owner !== t.request.owner ||
      e.taskId !== t.id ||
      e.correlationId !== t.request.correlationId ||
      e.causationId !== t.request.id ||
      e.from !== (reverse ? t.request.to : t.request.from) ||
      e.to !== (reverse ? t.request.from : t.request.to)
    )
      throw failure("conflict", "Message does not belong to this task.")
  }
  const put = (e: Envelope, now: number): Delivery => {
    const existing = delivery(e.id)
    if (existing) {
      if (canonicalEnvelope(existing.envelope) !== canonicalEnvelope(e))
        throw failure(
          "conflict",
          "Message identity already has different content."
        )
      return existing
    }
    requireSpace("communication_outbox")
    const value: Delivery = {
      envelope: e,
      status: "pending",
      attempts: 0,
      attemptLimit: MAX_ATTEMPTS,
      nextAt: now,
      error: null,
      receipt: null,
    }
    saveDelivery(value)
    return value
  }
  const newTask = (e: Envelope, direction: Task["direction"]): Task => ({
    id: e.taskId,
    direction,
    request: e,
    status: direction === "incoming" ? "accepted" : "waiting",
    outcome: null,
    revision: 0,
    leaseUntil: null,
    resumed: false,
    cancelRequested: false,
  })
  const finish = (t: Task, outcome: Outcome, now: number) => {
    Schema.decodeUnknownSync(Outcome)(outcome)
    const result: Envelope = {
      ...t.request,
      id: `result:${t.id}`,
      from: t.request.to,
      to: t.request.from,
      causationId: t.request.id,
      createdAt: now,
      deadline: now + RESULT_WINDOW_MS,
      payload: { kind: "result", outcome },
    }
    put(result, now)
    saveTask({
      ...t,
      status: outcome.status,
      outcome,
      revision: t.revision + 1,
      leaseUntil: null,
    })
  }
  const capacity = (direction: Task["direction"]) => {
    requireSpace("communication_tasks")
    const n = db.all<{ n: number }>(
      "SELECT count(*) AS n FROM communication_tasks WHERE direction=? AND status IN ('accepted','running','waiting','cancelling')",
      direction
    )[0]!.n
    if (n >= MAX_OPEN_TASKS)
      throw failure(
        "limit",
        "This bot already has three unfinished communication tasks."
      )
  }
  const service = Mailbox.of({
    identity: () => atomic(identity),
    enqueue: (raw, now) =>
      atomic(() => {
        const e = Schema.decodeUnknownSync(Envelope)(raw),
          self = identity()
        check(e)
        if (e.owner !== self.owner || e.from !== self.bot)
          throw failure("forbidden", "Sender does not match this bot.")
        const prior = delivery(e.id)
        if (prior) return put(e, now)
        if (!isRequest(e))
          throw failure("invalid", "Only task requests can be admitted here.")
        if (e.deadline <= now || e.createdAt > now + 60000)
          throw failure(
            "expired",
            "Task deadline has passed or its creation time is invalid."
          )
        if (
          db.all<{ n: number }>(
            "SELECT count(*) AS n FROM communication_tasks WHERE direction='outgoing' AND json_extract(body,'$.request.correlationId')=?",
            e.correlationId
          )[0]!.n >= MAX_OPEN_TASKS
        )
          throw failure(
            "limit",
            "This request already delegated its three permitted tasks."
          )
        capacity("outgoing")
        const result = put(e, now)
        saveTask(newTask(e, "outgoing"))
        return result
      }),
    prove: (e) =>
      atomic(() => {
        const self = identity(),
          row = delivery(e.id)
        return (
          e.owner === self.owner &&
          e.from === self.bot &&
          !!row &&
          canonicalEnvelope(row.envelope) === canonicalEnvelope(e)
        )
      }),
    accept: (raw, now) =>
      atomic(() => {
        const e = Schema.decodeUnknownSync(Envelope)(raw),
          self = identity()
        check(e)
        if (e.owner !== self.owner || e.to !== self.bot)
          throw failure("forbidden", "Recipient does not match this bot.")
        const existing = db.all<{ content: string; receipt: string }>(
          "SELECT content,receipt FROM communication_inbox WHERE id=?",
          e.id
        )[0]
        if (existing) {
          if (existing.content !== canonicalEnvelope(e))
            throw failure(
              "conflict",
              "Message identity already has different content."
            )
          return Schema.decodeUnknownSync(ReceiptJson)(existing.receipt)
        }
        if (e.deadline <= now || e.createdAt > now + 60000)
          throw failure(
            "expired",
            "Message deadline has passed or its creation time is invalid."
          )
        requireSpace("communication_inbox")
        if (isRequest(e)) {
          capacity("incoming")
          if (read("communication_tasks", e.taskId))
            throw failure("conflict", "Task identity already exists.")
          const t = newTask(e, "incoming")
          const cancelled = read("communication_cancellations", e.taskId)
          if (cancelled) {
            sameTask(
              Schema.decodeUnknownSync(EnvelopeJson)(cancelled),
              t,
              false
            )
            finish(
              { ...t, cancelRequested: true },
              { status: "cancelled", text: "Cancelled before execution." },
              now
            )
          } else saveTask(t)
        } else if (e.payload.kind === "cancel") {
          const prior = read("communication_cancellations", e.taskId)
          if (prior && prior !== canonicalEnvelope(e))
            throw failure("conflict", "Cancellation identity conflicts.")
          if (!prior) {
            requireSpace("communication_cancellations")
            db.run(
              "INSERT INTO communication_cancellations(id,body) VALUES (?,?)",
              e.taskId,
              canonicalEnvelope(e)
            )
          }
          if (read("communication_tasks", e.taskId)) {
            const t = task(e.taskId)
            if (t.direction !== "incoming")
              throw failure(
                "forbidden",
                "Only the requesting bot can cancel this task."
              )
            sameTask(e, t, false)
            if (!terminal(t))
              saveTask({
                ...t,
                cancelRequested: true,
                status: "cancelling",
                revision: t.revision + 1,
                leaseUntil: null,
              })
          }
        } else if (e.payload.kind === "result") {
          const t = task(e.taskId)
          if (t.direction !== "outgoing")
            throw failure("forbidden", "Unexpected result direction.")
          sameTask(e, t, true)
          if (!terminal(t))
            saveTask({
              ...t,
              status: e.payload.outcome.status,
              outcome: e.payload.outcome,
              revision: t.revision + 1,
            })
        }
        const receipt: Receipt = { id: e.id, taskId: e.taskId, acceptedAt: now }
        db.run(
          "INSERT INTO communication_inbox(id,content,receipt) VALUES (?,?,?)",
          e.id,
          canonicalEnvelope(e),
          Schema.encodeSync(ReceiptJson)(receipt)
        )
        return receipt
      }),
    tasks: () => atomic(tasks),
    task: (id) => atomic(() => task(id)),
    byTurn: (id) =>
      atomic(() =>
        db
          .all<{ body: string }>(
            "SELECT body FROM communication_tasks WHERE direction='outgoing' AND json_extract(body,'$.request.correlationId')=?",
            id
          )
          .map((row) => Schema.decodeUnknownSync(TaskJson)(row.body))
      ),
    pending: () =>
      atomic(() =>
        db
          .all<{ body: string }>(
            "SELECT body FROM communication_tasks WHERE (direction='incoming' AND status IN ('accepted','running','cancelling')) OR (direction='outgoing' AND json_extract(body,'$.resumed')=0) ORDER BY CASE WHEN status IN ('accepted','running','waiting','cancelling') THEN 0 ELSE 1 END,rowid LIMIT 100"
          )
          .map((row) => Schema.decodeUnknownSync(TaskJson)(row.body))
      ),
    resume: (id, admit) =>
      atomic(() => {
        const t = task(id)
        if (t.direction !== "outgoing" || !terminal(t) || t.resumed) return
        admit(t)
        saveTask({ ...t, resumed: true, revision: t.revision + 1 })
      }),
    deliveries: () =>
      atomic(() =>
        db
          .all<{ body: string }>(
            `SELECT body FROM communication_outbox WHERE json_extract(body,'$.envelope.taskId') IN (${taskSelection}) ORDER BY rowid DESC LIMIT 300`
          )
          .map((row) => Schema.decodeUnknownSync(DeliveryJson)(row.body))
      ),
    claimDelivery: (now) =>
      atomic(() => {
        const row = db.all<{ body: string }>(
          "SELECT body FROM communication_outbox WHERE status IN ('pending','delivering') AND next_at<=? ORDER BY next_at,id LIMIT 1",
          now
        )[0]
        if (!row) return undefined
        const d = Schema.decodeUnknownSync(DeliveryJson)(row.body)
        if (d.envelope.deadline <= now || d.attempts >= d.attemptLimit) {
          saveDelivery({
            ...d,
            status: d.envelope.deadline <= now ? "expired" : "failed",
            nextAt: null,
            error: "Delivery deadline or attempt budget exhausted.",
          })
          return undefined
        }
        const claimed: Delivery = {
          ...d,
          status: "delivering",
          attempts: d.attempts + 1,
          nextAt: now + LEASE_MS,
        }
        saveDelivery(claimed)
        return claimed
      }),
    delivered: (id, attempt, receipt) =>
      atomic(() => {
        const d = delivery(id)
        if (!d || d.attempts !== attempt || d.status !== "delivering") return
        Schema.decodeUnknownSync(Receipt)(receipt)
        if (receipt.id !== id || receipt.taskId !== d.envelope.taskId)
          throw failure(
            "conflict",
            "Acknowledgment belongs to another message."
          )
        saveDelivery({
          ...d,
          status: "accepted",
          receipt,
          nextAt: null,
          error: null,
        })
      }),
    deliveryFailed: (id, attempt, now, delay, permanent) =>
      atomic(() => {
        const d = delivery(id)
        if (!d || d.attempts !== attempt || d.status !== "delivering") return
        const expired = d.envelope.deadline <= now
        const done = permanent || expired || attempt >= d.attemptLimit
        saveDelivery({
          ...d,
          status: expired ? "expired" : done ? "failed" : "pending",
          nextAt: done ? null : Math.min(d.envelope.deadline, now + delay),
          error: permanent
            ? "Delivery was rejected. Inspect this message before retrying."
            : "Delivery could not be confirmed; retries preserve its identity.",
        })
      }),
    claimTask: (now) =>
      atomic(() => {
        const row = db.all<{ body: string }>(
          "SELECT body FROM communication_tasks WHERE direction='incoming' AND (status IN ('accepted','cancelling') OR (status='running' AND (lease_until<=? OR deadline<=?))) ORDER BY rowid LIMIT 1",
          now,
          now
        )[0]
        if (!row) return undefined
        const t = Schema.decodeUnknownSync(TaskJson)(row.body)
        const claimed = {
          ...t,
          status: t.cancelRequested
            ? ("cancelling" as const)
            : ("running" as const),
          revision: t.revision + 1,
          leaseUntil: now + LEASE_MS,
        }
        saveTask(claimed)
        return claimed
      }),
    finish: (id, revision, outcome, now) =>
      atomic(() => {
        const t = task(id)
        if (
          t.direction !== "incoming" ||
          t.revision !== revision ||
          terminal(t)
        )
          throw failure("stale", "This execution no longer owns the task.")
        if (t.cancelRequested && outcome.status !== "cancelled")
          throw failure(
            "stale",
            "Cancellation must be reconciled before completion."
          )
        if (
          now >= t.request.deadline &&
          !["cancelled", "expired"].includes(outcome.status)
        )
          throw failure("expired", "The task deadline has passed.")
        finish(t, outcome, now)
      }),
    cancel: (id, now) =>
      atomic(() => {
        const t = task(id)
        if (t.direction !== "outgoing")
          throw failure("forbidden", "Cancel from the requesting bot.")
        if (terminal(t) || t.cancelRequested) return t
        const e: Envelope = {
          ...t.request,
          id: `cancel:${t.id}`,
          causationId: t.id,
          createdAt: now,
          deadline: now + RESULT_WINDOW_MS,
          payload: {
            kind: "cancel",
            reason: "The owner or originating task requested cancellation.",
          },
        }
        put(e, now)
        const cancelled: Task = {
          ...t,
          cancelRequested: true,
          status: "cancelling",
          revision: t.revision + 1,
        }
        saveTask(cancelled)
        return cancelled
      }),
    retry: (id, now) =>
      atomic(() => {
        const d = delivery(id)
        if (!d) throw failure("not_found", "Message unavailable in this bot.")
        if (
          d.status === "pending" ||
          d.status === "delivering" ||
          d.status === "accepted"
        )
          return
        if (d.envelope.deadline <= now)
          throw failure("expired", "Expired messages cannot be retried.")
        if (isRequest(d.envelope)) {
          const t = task(d.envelope.taskId)
          if (t.cancelRequested || terminal(t))
            throw failure(
              "stale",
              "Stopped or finished requests cannot be retried."
            )
        }
        saveDelivery({
          ...d,
          status: "pending",
          attemptLimit: d.attempts + MAX_ATTEMPTS,
          nextAt: now,
          error: null,
        })
      }),
    expire: (now) =>
      atomic(() => {
        const rows = db.all<{ body: string }>(
          "SELECT body FROM communication_tasks WHERE direction='outgoing' AND status IN ('waiting','cancelling','accepted','running') AND deadline<=?",
          now
        )
        for (const row of rows) {
          const t = Schema.decodeUnknownSync(TaskJson)(row.body)
          saveTask({
            ...t,
            status: "expired",
            revision: t.revision + 1,
            outcome: {
              status: "expired",
              text: t.cancelRequested
                ? "Cancellation was requested; termination could not be confirmed before the deadline."
                : "The result was not confirmed before the task deadline.",
            },
          })
        }
      }),
    nextWake: () =>
      atomic(
        () =>
          db.all<{ at: number | null }>(
            "SELECT min(at) AS at FROM (SELECT next_at AS at FROM communication_outbox WHERE status IN ('pending','delivering') UNION ALL SELECT CASE WHEN status IN ('accepted','cancelling') THEN 0 ELSE min(lease_until,deadline) END AS at FROM communication_tasks WHERE direction='incoming' AND status IN ('accepted','running','cancelling') UNION ALL SELECT 0 AS at FROM communication_tasks WHERE direction='outgoing' AND status IN ('completed','failed','expired','cancelled','awaiting_input') AND json_extract(body,'$.resumed')=0 UNION ALL SELECT deadline AS at FROM communication_tasks WHERE direction='outgoing' AND status IN ('waiting','cancelling','accepted','running'))"
          )[0]?.at ?? undefined
      ),
  })
  const initialize = atomic(() => {
    db.run(
      "CREATE TABLE IF NOT EXISTS communication_identity(id TEXT PRIMARY KEY,body TEXT NOT NULL)"
    )
    db.run(
      "CREATE TABLE IF NOT EXISTS communication_outbox(id TEXT PRIMARY KEY,body TEXT NOT NULL,status TEXT NOT NULL,next_at INTEGER)"
    )
    db.run(
      "CREATE INDEX IF NOT EXISTS communication_outbox_due ON communication_outbox(status,next_at)"
    )
    db.run(
      "CREATE TABLE IF NOT EXISTS communication_inbox(id TEXT PRIMARY KEY,content TEXT NOT NULL,receipt TEXT NOT NULL)"
    )
    db.run(
      "CREATE TABLE IF NOT EXISTS communication_tasks(id TEXT PRIMARY KEY,body TEXT NOT NULL,status TEXT NOT NULL,lease_until INTEGER,deadline INTEGER NOT NULL,direction TEXT NOT NULL)"
    )
    db.run(
      "CREATE TABLE IF NOT EXISTS communication_cancellations(id TEXT PRIMARY KEY,body TEXT NOT NULL)"
    )
    return service
  })
  return {
    layer: Layer.effect(Mailbox, initialize),
    initialize,
    bindIdentity: (raw: Identity) =>
      atomic(() => {
        const value = Schema.decodeUnknownSync(Identity)(raw)
        const before = read("communication_identity", "self"),
          body = Schema.encodeSync(IdentityJson)(value)
        if (before && before !== body)
          throw failure("forbidden", "Bot identity cannot be reassigned.")
        db.run(
          "INSERT OR IGNORE INTO communication_identity(id,body) VALUES ('self',?)",
          body
        )
      }),
  }
}
