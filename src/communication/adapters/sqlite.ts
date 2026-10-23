import { and, count, desc, eq, inArray, lte } from "drizzle-orm"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"
import type { SQLiteTable } from "drizzle-orm/sqlite-core"
import { Cause, Clock, Effect, Layer, Schema } from "effect"

import { mapSqliteError, type Sqlite } from "../../storage/sqlite"
import {
  CommunicationError,
  Delivery,
  Envelope,
  Identity,
  Receipt,
  Task,
  canonicalEnvelope,
  failure,
  isRequest,
} from "../contracts"
import * as Domain from "../domain"
import { Mailbox } from "../mailbox"
import { advanceTask } from "../task.machine"
import {
  communicationIdentity as identities,
  communicationOutbox as outbox,
  communicationInbox as inbox,
  communicationTasks as taskTable,
  communicationCancellations as cancellations,
} from "./schema"

const DeliveryJson = Schema.fromJsonString(Delivery),
  TaskJson = Schema.fromJsonString(Task),
  ReceiptJson = Schema.fromJsonString(Receipt),
  EnvelopeJson = Schema.fromJsonString(Envelope),
  IdentityJson = Schema.fromJsonString(Identity)
const decide = <TValue>(body: () => TValue) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      if (Schema.is(CommunicationError)(cause)) return cause
      throw cause
    },
  })
export function sqliteMailbox(db: Sqlite) {
  const storage = () =>
    failure(
      "storage",
      "Mailbox state could not be confirmed. Retry the same operation."
    )
  const q = <TValue>(work: Effect.Effect<TValue, EffectDrizzleQueryError>) =>
    mapSqliteError(work, storage)
  const atomic = <TValue, TError, TRequirements>(
    body: () => Effect.Effect<TValue, TError, TRequirements>
  ) => mapSqliteError(db.transaction(body), storage)
  const identity = () =>
    db
      .use((orm) =>
        q(orm.select().from(identities).where(eq(identities.id, "self")))
      )
      .pipe(
        Effect.flatMap(([row]) =>
          row
            ? Effect.sync(() =>
                Schema.decodeUnknownSync(IdentityJson)(row.body)
              )
            : Effect.fail(
                failure("forbidden", "This bot has no communication identity.")
              )
        )
      )
  const delivery = (id: string) =>
    db
      .use((orm) => q(orm.select().from(outbox).where(eq(outbox.id, id))))
      .pipe(
        Effect.flatMap(([row]) =>
          decide(() => (row ? readDeliveryRow(row) : undefined))
        )
      )
  const task = (id: string) =>
    db
      .use((orm) => q(orm.select().from(taskTable).where(eq(taskTable.id, id))))
      .pipe(
        Effect.flatMap(([row]) =>
          row
            ? decide(() => readTaskRow(row))
            : Effect.fail(failure("not_found", "Task unavailable in this bot."))
        )
      )
  const readCancellation = (id: string) =>
    db
      .use((orm) =>
        q(orm.select().from(cancellations).where(eq(cancellations.id, id)))
      )
      .pipe(Effect.map(([row]) => row?.body))
  const saveDelivery = (d: Delivery) =>
    db
      .use((orm) =>
        q(
          orm
            .insert(outbox)
            .values({
              id: d.envelope.id,
              body: Schema.encodeSync(DeliveryJson)(d),
              status: d.status,
              next_at: d.nextAt,
            })
            .onConflictDoUpdate({
              target: outbox.id,
              set: {
                body: Schema.encodeSync(DeliveryJson)(d),
                status: d.status,
                next_at: d.nextAt,
              },
            })
        )
      )
      .pipe(Effect.asVoid)
  const saveTask = (t: Task) =>
    db
      .use((orm) =>
        q(
          orm
            .insert(taskTable)
            .values({
              id: t.id,
              body: Schema.encodeSync(TaskJson)(t),
              status: t.status,
              lease_until: t.leaseUntil,
              deadline: t.request.deadline,
              direction: t.direction,
            })
            .onConflictDoUpdate({
              target: taskTable.id,
              set: {
                body: Schema.encodeSync(TaskJson)(t),
                status: t.status,
                lease_until: t.leaseUntil,
              },
            })
        )
      )
      .pipe(Effect.asVoid)
  const allTasks = () =>
    db
      .use((orm) =>
        q(orm.select().from(taskTable).orderBy(desc(taskTable.sequence)))
      )
      .pipe(
        Effect.flatMap((rows) =>
          decide(() => rows.map((row) => readTaskRow(row)))
        )
      )
  const open = (t: Task) =>
    ["accepted", "running", "waiting", "cancelling"].includes(t.status)
  const recovering = (t: Task) =>
    t.direction === "incoming" &&
    (open(t) ||
      t.control.owner !== null ||
      t.control.unconfirmed ||
      t.stop.status === "pending" ||
      t.stop.status === "unconfirmed")
  const selectedPriority = (t: Task) =>
    recovering(t) || open(t) || (t.direction === "outgoing" && !t.resumed)
  const selectedTasks = () =>
    allTasks().pipe(
      Effect.map((tasks) => {
        const selected = new Set(
          [
            ...tasks.filter(selectedPriority),
            ...tasks.filter((task) => !selectedPriority(task)),
          ]
            .slice(0, 100)
            .map((t) => t.id)
        )
        return tasks.filter((t) => selected.has(t.id))
      })
    )
  const requireSpace = (table: SQLiteTable) =>
    db
      .use((orm) => q(orm.select({ n: count() }).from(table)))
      .pipe(
        Effect.flatMap(([row]) =>
          decide(() =>
            Domain.requireRetainedCapacity(
              row!.n,
              table === outbox || table === inbox
            )
          )
        )
      )
  const put = (
    e: Envelope,
    now: number
  ): Effect.Effect<Delivery, CommunicationError> =>
    Effect.gen(function* () {
      const existing = yield* delivery(e.id)
      if (existing)
        return yield* decide(() => Domain.replayDelivery(existing, e))
      yield* requireSpace(outbox)
      const value = Domain.newDelivery(e, now)
      yield* saveDelivery(value)
      return value
    })
  const capacity = (direction: Task["direction"]) =>
    Effect.gen(function* () {
      yield* requireSpace(taskTable)
      const rows = yield* db.use((orm) =>
        q(
          orm
            .select({ n: count() })
            .from(taskTable)
            .where(
              and(
                eq(taskTable.direction, direction),
                inArray(taskTable.status, [
                  "accepted",
                  "running",
                  "waiting",
                  "cancelling",
                ])
              )
            )
        )
      )
      yield* decide(() => Domain.requireOpenCapacity(rows[0]!.n))
    })
  const service = Mailbox.of({
    transactionGroup: db,
    identity: () => atomic(identity),
    enqueue: (raw, now, options) =>
      atomic(() =>
        Effect.gen(function* () {
          const e = yield* decide(() => Domain.validateEnvelope(raw)),
            self = yield* identity()
          yield* decide(() => Domain.requireParty(e, self, "sender"))
          if (yield* delivery(e.id)) return yield* put(e, now)
          if (!isRequest(e))
            return yield* failure(
              "invalid",
              "Only task requests can be admitted here."
            )
          const admissionNow = Math.max(now, yield* Clock.currentTimeMillis)
          yield* decide(() => Domain.requireTimely(e, admissionNow, "Task"))
          yield* decide(() => Domain.requireDiscovery(options, admissionNow))
          const tasks = yield* allTasks()
          yield* decide(() =>
            Domain.requireFanout(
              tasks.filter(
                (t) =>
                  t.direction === "outgoing" &&
                  t.request.correlationId === e.correlationId
              ).length
            )
          )
          yield* capacity("outgoing")
          const result = yield* put(e, now)
          yield* saveTask(Domain.newTask(e, "outgoing"))
          return result
        })
      ),
    prove: (e) =>
      atomic(() =>
        Effect.gen(function* () {
          const self = yield* identity(),
            row = yield* delivery(e.id)
          return (
            e.owner === self.owner &&
            e.from === self.bot &&
            !!row &&
            canonicalEnvelope(row.envelope) === canonicalEnvelope(e)
          )
        })
      ),
    accepted: (raw) =>
      atomic(() =>
        Effect.gen(function* () {
          const e = yield* decide(() => Domain.validateEnvelope(raw))
          const self = yield* identity()
          yield* decide(() => Domain.requireParty(e, self, "recipient"))
          const [row] = yield* db.use((orm) =>
            q(orm.select().from(inbox).where(eq(inbox.id, e.id)))
          )
          if (!row) return undefined
          if (row.content !== canonicalEnvelope(e))
            return yield* failure(
              "conflict",
              "Message identity already has different content."
            )
          return Schema.decodeUnknownSync(ReceiptJson)(row.receipt)
        })
      ),
    accept: (raw, now, options) =>
      atomic(() =>
        Effect.gen(function* () {
          const e = yield* decide(() => Domain.validateEnvelope(raw)),
            self = yield* identity()
          yield* decide(() => Domain.requireParty(e, self, "recipient"))
          const [existing] = yield* db.use((orm) =>
            q(orm.select().from(inbox).where(eq(inbox.id, e.id)))
          )
          if (existing) {
            if (existing.content !== canonicalEnvelope(e))
              return yield* failure(
                "conflict",
                "Message identity already has different content."
              )
            return Schema.decodeUnknownSync(ReceiptJson)(existing.receipt)
          }
          const admissionNow = Math.max(now, yield* Clock.currentTimeMillis)
          yield* decide(() => Domain.requireTimely(e, admissionNow, "Message"))
          if (e.payload.kind !== "cancel")
            yield* decide(() => Domain.requireDiscovery(options, admissionNow))
          yield* requireSpace(inbox)
          if (isRequest(e)) {
            yield* capacity("incoming")
            const prior = (yield* allTasks()).find((t) => t.id === e.taskId)
            if (prior)
              return yield* failure("conflict", "Task identity already exists.")
            const t = Domain.newTask(e, "incoming"),
              cancelled = yield* readCancellation(e.taskId)
            if (cancelled) {
              yield* decide(() =>
                Domain.requireSameTask(
                  Schema.decodeUnknownSync(EnvelopeJson)(cancelled),
                  t,
                  false
                )
              )
              const cancelledTask = yield* decide(() =>
                advanceTask(t, { type: "BEFORE_START_CANCEL", now })
              )
              yield* put(
                Domain.taskResult(cancelledTask, cancelledTask.outcome!, now)
                  .envelope,
                now
              )
              yield* saveTask(cancelledTask)
            } else yield* saveTask(t)
          } else if (e.payload.kind === "cancel") {
            const prior = yield* readCancellation(e.taskId)
            if (prior && prior !== canonicalEnvelope(e))
              return yield* failure(
                "conflict",
                "Cancellation identity conflicts."
              )
            if (!prior) {
              yield* requireSpace(cancellations)
              yield* db.use((orm) =>
                q(
                  orm
                    .insert(cancellations)
                    .values({ id: e.taskId, body: canonicalEnvelope(e) })
                )
              )
            }
            const priorTask = (yield* allTasks()).find((t) => t.id === e.taskId)
            if (priorTask) {
              const transition = yield* decide(() =>
                Domain.receiveCancellation(priorTask, e, admissionNow)
              )
              if (transition) yield* saveTask(transition)
            }
          } else if (e.payload.kind === "result") {
            const current = yield* task(e.taskId),
              transition = yield* decide(() => Domain.receiveResult(current, e))
            if (transition) yield* saveTask(transition)
          }
          const receipt: Receipt = {
            id: e.id,
            taskId: e.taskId,
            acceptedAt: now,
          }
          yield* db.use((orm) =>
            q(
              orm.insert(inbox).values({
                id: e.id,
                content: canonicalEnvelope(e),
                receipt: Schema.encodeSync(ReceiptJson)(receipt),
              })
            )
          )
          return receipt
        })
      ),
    tasks: () => atomic(selectedTasks),
    recovery: () =>
      atomic(() =>
        allTasks().pipe(Effect.map((tasks) => tasks.filter(recovering)))
      ),
    task: (id) => atomic(() => task(id)),
    byTurn: (id) =>
      atomic(() =>
        allTasks().pipe(
          Effect.map((tasks) =>
            [...tasks]
              .reverse()
              .filter(
                (t) =>
                  t.direction === "outgoing" && t.request.correlationId === id
              )
          )
        )
      ),
    pending: () =>
      atomic(() =>
        allTasks().pipe(
          Effect.map((tasks) => {
            const eligible = [...tasks]
              .reverse()
              .filter(
                (t) =>
                  (t.direction === "incoming" &&
                    (["accepted", "running", "cancelling"].includes(t.status) ||
                      t.stop.status === "pending")) ||
                  (t.direction === "outgoing" &&
                    !t.resumed &&
                    !t.control.unconfirmed)
              )
            return [
              ...eligible.filter((t) => open(t)),
              ...eligible.filter((t) => !open(t)),
            ].slice(0, 100)
          })
        )
      ),
    resume: (id, admission) =>
      atomic(() =>
        Effect.gen(function* () {
          if (admission.transactionGroup !== db)
            return yield* failure(
              "conflict",
              "Continuation admission must share the mailbox transaction."
            )
          const t = yield* task(id)
          if (!Domain.resumable(t)) return
          const consumed = yield* decide(() =>
            Domain.consumeResult(t, admission.control)
          )
          const result = yield* Effect.catchCause(admission.admit(t), (cause) =>
            Effect.failCause(
              Cause.map(cause, (error) =>
                failure(
                  error._tag === "ConversationStorageError"
                    ? "storage"
                    : error._tag === "ConversationFull"
                      ? "limit"
                      : "conflict",
                  error._tag === "ConversationStorageError"
                    ? "Continuation admission could not be confirmed. Retry the same operation."
                    : error._tag === "ConversationFull"
                      ? "The conversation queue is full. Retry this continuation later."
                      : "Continuation admission conflicts with its saved conversation identity."
                )
              )
            )
          )

          if (
            result.kind === "admitted" &&
            result.turnId !== admission.operationId
          )
            return yield* failure(
              "conflict",
              "Continuation admission changed its operation identity."
            )
          yield* saveTask(consumed)
        })
      ),
    discard: (id, control) =>
      atomic(() =>
        Effect.gen(function* () {
          const t = yield* task(id)
          if (t.direction === "outgoing" && t.outcome !== null && !t.resumed) {
            const consumed = yield* decide(() =>
              Domain.consumeResult(t, control, true)
            )
            yield* saveTask(consumed)
          }
        })
      ),
    deliveries: () =>
      atomic(() =>
        Effect.gen(function* () {
          const selected = new Set((yield* selectedTasks()).map((t) => t.id))
          const rows = yield* db.use((orm) =>
            q(orm.select().from(outbox).orderBy(desc(outbox.sequence)))
          )
          return (yield* decide(() => rows.map((row) => readDeliveryRow(row))))
            .filter((d) => selected.has(d.envelope.taskId))
            .slice(0, 300)
        })
      ),
    claimDelivery: (now) =>
      atomic(() =>
        Effect.gen(function* () {
          const [row] = yield* db.use((orm) =>
            q(
              orm
                .select()
                .from(outbox)
                .where(
                  and(
                    inArray(outbox.status, ["pending", "delivering"]),
                    lte(outbox.next_at, now)
                  )
                )
                .orderBy(outbox.next_at, outbox.id)
                .limit(1)
            )
          )
          if (!row) return undefined
          const d = yield* decide(() => readDeliveryRow(row)),
            claimed = yield* decide(() => Domain.claimDelivery(d, now))
          yield* saveDelivery(claimed)
          return claimed.status === "delivering" ? claimed : undefined
        })
      ),
    delivered: (id, attempt, receipt) =>
      atomic(() =>
        Effect.gen(function* () {
          const d = yield* delivery(id),
            transition = yield* decide(
              () => d && Domain.acknowledge(d, attempt, receipt)
            )
          if (transition) yield* saveDelivery(transition)
        })
      ),
    deliveryFailed: (id, attempt, now, delay, permanent) =>
      atomic(() =>
        Effect.gen(function* () {
          const d = yield* delivery(id),
            transition = yield* decide(
              () =>
                d && Domain.deliveryFailed(d, attempt, now, delay, permanent)
            )
          if (transition) yield* saveDelivery(transition)
        })
      ),
    claimContinuation: (id, now, options) =>
      atomic(() =>
        Effect.gen(function* () {
          const current = yield* task(id)
          const claimNow = Math.max(now, yield* Clock.currentTimeMillis)
          const next = yield* decide(() =>
            advanceTask(current, {
              type: "CLAIM_CONTINUATION",
              now: claimNow,
              ...options,
            })
          )
          if (next.revision === current.revision) return undefined
          yield* saveTask(next)
          return next.control.owner === options.owner ? next : undefined
        })
      ),
    claimTask: (now, options) =>
      atomic(() =>
        Effect.gen(function* () {
          const rows = yield* db.use((orm) =>
            q(
              orm
                .select()
                .from(taskTable)
                .where(eq(taskTable.direction, "incoming"))
                .orderBy(taskTable.sequence)
            )
          )
          for (const row of rows) {
            const previous = yield* decide(() => readTaskRow(row))
            const claimed = yield* decide(() =>
              Domain.claimTask(previous, now, options)
            )
            if (!claimed) continue
            yield* saveTask(claimed)
            if (claimed.control.owner === options.owner) return claimed
          }
          return undefined
        })
      ),
    finish: (id, revision, outcome, now, owner) =>
      atomic(() =>
        Effect.gen(function* () {
          const t = yield* task(id)
          const next = yield* decide(() =>
            Domain.requireFinish(t, revision, outcome, now, owner)
          )
          yield* put(Domain.taskResult(next, outcome, now).envelope, now)
          yield* saveTask(next)
        })
      ),
    releaseTask: (receipt) =>
      atomic(() =>
        Effect.gen(function* () {
          const t = yield* task(receipt.taskId)
          const next = yield* decide(() =>
            advanceTask(t, { type: "RELEASE", receipt })
          )
          if (next.revision === t.revision) return false
          if (t.outcome === null && next.outcome !== null)
            yield* put(
              Domain.taskResult(next, next.outcome, receipt.now).envelope,
              receipt.now
            )
          yield* saveTask(next)
          return true
        })
      ),
    restoreControl: (now) =>
      atomic(() =>
        Effect.gen(function* () {
          for (const t of yield* allTasks()) {
            const next = yield* decide(() =>
              advanceTask(t, { type: "RESTORE", now })
            )
            if (next.revision !== t.revision) yield* saveTask(next)
          }
        })
      ),
    exhaustControl: (attempt, now, current) =>
      atomic(() =>
        Effect.gen(function* () {
          if (!current()) return false
          const t = yield* task(attempt.taskId)
          const next = yield* decide(() =>
            advanceTask(t, { type: "EXHAUST", ...attempt, now })
          )
          if (next.revision === t.revision) return false
          yield* saveTask(next)
          return true
        })
      ),
    cancel: (id, now) =>
      atomic(() =>
        Effect.gen(function* () {
          const t = yield* task(id),
            transition = yield* decide(() => Domain.cancelTask(t, now))
          if (!transition) return t
          yield* put(transition.envelope, now)
          yield* saveTask(transition.task)
          return transition.task
        })
      ),
    retry: (id, now, options) =>
      atomic(() =>
        Effect.gen(function* () {
          const admissionNow = Math.max(now, yield* Clock.currentTimeMillis)
          const [row] = yield* db.use((orm) =>
            q(orm.select().from(taskTable).where(eq(taskTable.id, id)))
          )
          if (row) {
            const continuation = yield* decide(() => readTaskRow(row))
            if (
              continuation.direction === "outgoing" &&
              continuation.outcome !== null &&
              !continuation.resumed &&
              continuation.control.phase === "continuation" &&
              continuation.control.unconfirmed
            ) {
              yield* decide(() =>
                Domain.requireDiscovery(options, admissionNow)
              )
              const next = yield* decide(() =>
                advanceTask(continuation, { type: "RETRY_CONTINUATION" })
              )
              if (next.revision === continuation.revision)
                return yield* failure(
                  "stale",
                  "This continuation still has a live owner."
                )
              yield* saveTask(next)
              return
            }
          }
          const d = yield* delivery(id)
          if (!d)
            return yield* failure(
              "not_found",
              "Message unavailable in this bot."
            )
          const transition = yield* decide(() =>
            Domain.retryDelivery(d, admissionNow)
          )
          if (!transition) return
          yield* decide(() => Domain.requireDiscovery(options, admissionNow))
          if (isRequest(d.envelope)) {
            const t = yield* task(d.envelope.taskId)
            yield* decide(() => Domain.requireRetryableTask(t))
          }
          yield* saveDelivery(transition)
        })
      ),
    expire: (now) =>
      atomic(() =>
        Effect.gen(function* () {
          const tasks = yield* allTasks()
          for (const t of tasks)
            if (
              t.direction === "outgoing" &&
              open(t) &&
              t.request.deadline <= now
            )
              yield* saveTask(Domain.expireTask(t))
        })
      ),
    nextWake: () =>
      atomic(() =>
        Effect.gen(function* () {
          const deliveries = yield* db.use((orm) =>
            q(
              orm
                .select()
                .from(outbox)
                .where(inArray(outbox.status, ["pending", "delivering"]))
            )
          )
          const times = deliveries.flatMap((row) =>
            row.next_at === null ? [] : [row.next_at]
          )
          for (const t of yield* allTasks()) {
            if (t.direction === "incoming") {
              if (t.control.owner !== null && !t.control.unconfirmed)
                times.push(t.control.deadline ?? t.request.deadline)
              else if (t.stop.status === "pending")
                times.push(t.stop.nextAt ?? 0)
              else if (
                !t.control.unconfirmed &&
                t.stop.status !== "unconfirmed" &&
                ![
                  "completed",
                  "failed",
                  "expired",
                  "cancelled",
                  "awaiting_input",
                ].includes(t.status)
              )
                times.push(t.leaseUntil ?? 0)
            }
            if (Domain.resumable(t))
              times.push(
                t.control.owner === null ? 0 : (t.control.deadline ?? 0)
              )
            if (t.direction === "outgoing" && open(t))
              times.push(t.request.deadline)
          }
          return times.length ? Math.min(...times) : undefined
        })
      ),
  })
  const initialize = migrateCommunication(db).pipe(Effect.as(service))
  return {
    layer: Layer.effect(Mailbox, initialize),
    initialize,
    bindIdentity: (raw: Identity) =>
      atomic(() =>
        Effect.gen(function* () {
          const value = yield* Effect.try({
            try: () => Schema.decodeUnknownSync(Identity)(raw),
            catch: (cause) => {
              if (Schema.isSchemaError(cause))
                return failure("invalid", "Invalid mailbox input.")
              throw cause
            },
          })
          const [before] = yield* db.use((orm) =>
              q(orm.select().from(identities).where(eq(identities.id, "self")))
            ),
            body = Schema.encodeSync(IdentityJson)(value)
          if (before && before.body !== body)
            return yield* failure(
              "forbidden",
              "Bot identity cannot be reassigned."
            )
          yield* db.use((orm) =>
            q(
              orm
                .insert(identities)
                .values({ id: "self", body })
                .onConflictDoNothing()
            )
          )
        })
      ),
  }
}

function readTaskRow(row: typeof taskTable.$inferSelect): Task {
  let raw: unknown
  try {
    raw = JSON.parse(row.body)
  } catch {
    throw failure(
      "incompatible",
      "Invalid communication task JSON; retain the row for recovery."
    )
  }
  const task = Domain.readTask(raw)
  if (
    task.id !== row.id ||
    task.status !== row.status ||
    task.leaseUntil !== row.lease_until ||
    task.request.deadline !== row.deadline ||
    task.direction !== row.direction
  )
    throw failure(
      "incompatible",
      "Communication task projection does not match its authoritative record."
    )
  return task
}
function readDeliveryRow(row: typeof outbox.$inferSelect): Delivery {
  let raw: unknown
  try {
    raw = JSON.parse(row.body)
  } catch {
    throw failure(
      "incompatible",
      "Invalid communication delivery JSON; retain the row for recovery."
    )
  }
  const delivery = Domain.readDelivery(raw)
  if (
    delivery.envelope.id !== row.id ||
    delivery.status !== row.status ||
    delivery.nextAt !== row.next_at
  )
    throw failure(
      "incompatible",
      "Communication delivery projection does not match its authoritative record."
    )
  return delivery
}

/** Register after schema migration. Conversion preserves sequence/projections and inbox bytes. */
export function migrateCommunication(db: Sqlite) {
  return mapSqliteError(
    db.transaction(() =>
      Effect.gen(function* () {
        const tasks = yield* db.use((orm) => orm.select().from(taskTable))
        const deliveries = yield* db.use((orm) => orm.select().from(outbox))
        // Validate every row before the first conversion, then commit both families together.
        const taskBodies = yield* decide(() =>
          tasks.map((row) => ({ row, value: readTaskRow(row) }))
        )
        const deliveryBodies = yield* decide(() =>
          deliveries.map((row) => ({ row, value: readDeliveryRow(row) }))
        )
        for (const { row, value } of taskBodies) {
          if (
            (JSON.parse(row.body) as { schemaVersion?: unknown })
              .schemaVersion === 1
          )
            continue
          yield* db.use((orm) =>
            orm
              .update(taskTable)
              .set({ body: Schema.encodeSync(TaskJson)(value) })
              .where(eq(taskTable.id, row.id))
          )
        }
        for (const { row, value } of deliveryBodies) {
          if (
            (JSON.parse(row.body) as { schemaVersion?: unknown })
              .schemaVersion === 1
          )
            continue
          yield* db.use((orm) =>
            orm
              .update(outbox)
              .set({ body: Schema.encodeSync(DeliveryJson)(value) })
              .where(eq(outbox.id, row.id))
          )
        }
      })
    ),
    () =>
      failure(
        "storage",
        "Communication data conversion failed; the transaction retained its original rows."
      )
  )
}
