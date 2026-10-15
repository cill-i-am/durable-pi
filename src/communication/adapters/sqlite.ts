import { Effect, Layer, Schema } from "effect"
import type { Sqlite } from "../../storage/sqlite"
import { Mailbox } from "../mailbox"
import * as Domain from "../domain"
import {
  ConversationConflict,
  ConversationFull,
  ConversationStorageError,
} from "../../conversations/turns"
import {
  CommunicationError,
  Delivery,
  Envelope,
  Identity,
  type Outcome,
  Receipt,
  Task,
  canonicalEnvelope,
  failure,
  isRequest,
} from "../contracts"

const DeliveryJson = Schema.fromJsonString(Delivery)
const TaskJson = Schema.fromJsonString(Task)
const ReceiptJson = Schema.fromJsonString(Receipt)
const EnvelopeJson = Schema.fromJsonString(Envelope)
const IdentityJson = Schema.fromJsonString(Identity)

export function sqliteMailbox(nativeDb: Sqlite) {
  const storage = <T>(body: () => T): T => {
    try {
      return body()
    } catch {
      throw failure(
        "storage",
        "Mailbox state could not be confirmed. Retry the same operation."
      )
    }
  }
  const db: Sqlite = {
    all: (query, ...bindings) =>
      storage(() => nativeDb.all(query, ...bindings)),
    run: (query, ...bindings) =>
      storage(() => nativeDb.run(query, ...bindings)),
    transaction: (body) => {
      const callback: { failed: boolean; cause?: unknown } = { failed: false }
      try {
        return nativeDb.transaction(() => {
          try {
            return body()
          } catch (cause) {
            callback.failed = true
            callback.cause = cause
            throw cause
          }
        })
      } catch (cause) {
        if (callback.failed && cause === callback.cause) throw cause
        throw failure(
          "storage",
          "Mailbox state could not be confirmed. Retry the same operation."
        )
      }
    },
  }
  const input = <T>(decode: () => T): T => {
    try {
      return decode()
    } catch (cause) {
      if (Schema.isSchemaError(cause))
        throw failure("invalid", "Invalid mailbox input.")
      throw cause
    }
  }
  const atomic = <T>(body: () => T) =>
    Effect.try({
      try: () => db.transaction(body),
      catch: (error) => {
        const communicationError =
          Schema.decodeUnknownOption(CommunicationError)(error)
        if (communicationError._tag === "Some") return communicationError.value
        throw error
      },
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
    Domain.requireRetainedCapacity(
      count(table),
      table === "communication_outbox" || table === "communication_inbox"
    )
  }
  const put = (e: Envelope, now: number): Delivery => {
    const existing = delivery(e.id)
    if (existing) return Domain.replayDelivery(existing, e)
    requireSpace("communication_outbox")
    const value = Domain.newDelivery(e, now)
    saveDelivery(value)
    return value
  }
  const finish = (t: Task, outcome: Outcome, now: number) => {
    const result = Domain.taskResult(t, outcome, now)
    put(result.envelope, now)
    saveTask(result.task)
  }
  const capacity = (direction: Task["direction"]) => {
    requireSpace("communication_tasks")
    const n = db.all<{ n: number }>(
      "SELECT count(*) AS n FROM communication_tasks WHERE direction=? AND status IN ('accepted','running','waiting','cancelling')",
      direction
    )[0]!.n
    Domain.requireOpenCapacity(n)
  }
  const service = Mailbox.of({
    transactionGroup: nativeDb,
    identity: () => atomic(identity),
    enqueue: (raw, now) =>
      atomic(() => {
        const e = Domain.validateEnvelope(raw),
          self = identity()
        Domain.requireParty(e, self, "sender")
        const prior = delivery(e.id)
        if (prior) return put(e, now)
        if (!isRequest(e))
          throw failure("invalid", "Only task requests can be admitted here.")
        Domain.requireTimely(e, now, "Task")
        Domain.requireFanout(
          db.all<{ n: number }>(
            "SELECT count(*) AS n FROM communication_tasks WHERE direction='outgoing' AND json_extract(body,'$.request.correlationId')=?",
            e.correlationId
          )[0]!.n
        )
        capacity("outgoing")
        const result = put(e, now)
        saveTask(Domain.newTask(e, "outgoing"))
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
        const e = Domain.validateEnvelope(raw),
          self = identity()
        Domain.requireParty(e, self, "recipient")
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
        Domain.requireTimely(e, now, "Message")
        requireSpace("communication_inbox")
        if (isRequest(e)) {
          capacity("incoming")
          if (read("communication_tasks", e.taskId))
            throw failure("conflict", "Task identity already exists.")
          const t = Domain.newTask(e, "incoming")
          const cancelled = read("communication_cancellations", e.taskId)
          if (cancelled) {
            Domain.requireSameTask(
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
            const transition = Domain.receiveCancellation(t, e)
            if (transition) saveTask(transition)
          }
        } else if (e.payload.kind === "result") {
          const t = task(e.taskId)
          const transition = Domain.receiveResult(t, e)
          if (transition) saveTask(transition)
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
    resume: (id, admission) =>
      atomic(() => {
        if (admission.transactionGroup !== nativeDb)
          throw failure(
            "conflict",
            "Continuation admission must share the mailbox transaction."
          )
        const t = task(id)
        if (!Domain.resumable(t)) return
        let result: ReturnType<typeof admission.admit>
        try {
          result = admission.admit(t)
        } catch (cause) {
          const conversationStorageError = Schema.decodeUnknownOption(
            ConversationStorageError
          )(cause)
          if (conversationStorageError._tag === "Some")
            throw failure(
              "storage",
              "Continuation admission could not be confirmed. Retry the same operation."
            )
          const conversationFull =
            Schema.decodeUnknownOption(ConversationFull)(cause)
          if (conversationFull._tag === "Some")
            throw failure(
              "limit",
              "The conversation queue is full. Retry this continuation later."
            )
          const conversationConflict =
            Schema.decodeUnknownOption(ConversationConflict)(cause)
          if (conversationConflict._tag === "Some")
            throw failure(
              "conflict",
              "Continuation admission conflicts with its saved conversation identity."
            )
          throw cause
        }
        if (
          result.kind === "admitted" &&
          result.turnId !== admission.operationId
        )
          throw failure(
            "conflict",
            "Continuation admission changed its operation identity."
          )
        saveTask(Domain.consumeResult(t))
      }),
    discard: (id) =>
      atomic(() => {
        const t = task(id)
        if (!Domain.resumable(t)) return
        saveTask(Domain.consumeResult(t))
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
        const claimed = Domain.claimDelivery(d, now)
        saveDelivery(claimed)
        return claimed.status === "delivering" ? claimed : undefined
      }),
    delivered: (id, attempt, receipt) =>
      atomic(() => {
        const d = delivery(id)
        const transition = d && Domain.acknowledge(d, attempt, receipt)
        if (transition) saveDelivery(transition)
      }),
    deliveryFailed: (id, attempt, now, delay, permanent) =>
      atomic(() => {
        const d = delivery(id)
        const transition =
          d && Domain.deliveryFailed(d, attempt, now, delay, permanent)
        if (transition) saveDelivery(transition)
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
        const claimed = Domain.claimTask(t, now)
        saveTask(claimed)
        return claimed
      }),
    finish: (id, revision, outcome, now) =>
      atomic(() => {
        const t = task(id)
        Domain.requireFinish(t, revision, outcome, now)
        finish(t, outcome, now)
      }),
    cancel: (id, now) =>
      atomic(() => {
        const t = task(id)
        const transition = Domain.cancelTask(t, now)
        if (!transition) return t
        put(transition.envelope, now)
        saveTask(transition.task)
        return transition.task
      }),
    retry: (id, now) =>
      atomic(() => {
        const d = delivery(id)
        if (!d) throw failure("not_found", "Message unavailable in this bot.")
        const transition = Domain.retryDelivery(d, now)
        if (!transition) return
        if (isRequest(d.envelope)) {
          const t = task(d.envelope.taskId)
          Domain.requireRetryableTask(t)
        }
        saveDelivery(transition)
      }),
    expire: (now) =>
      atomic(() => {
        const rows = db.all<{ body: string }>(
          "SELECT body FROM communication_tasks WHERE direction='outgoing' AND status IN ('waiting','cancelling','accepted','running') AND deadline<=?",
          now
        )
        for (const row of rows) {
          const t = Schema.decodeUnknownSync(TaskJson)(row.body)
          saveTask(Domain.expireTask(t))
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
        const value = input(() => Schema.decodeUnknownSync(Identity)(raw))
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
