import { and, count, desc, eq, inArray, lte, or } from "drizzle-orm"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"
import type { SQLiteTable } from "drizzle-orm/sqlite-core"
import { Cause, Effect, Layer, Schema } from "effect"

import { mapSqliteError, type Sqlite } from "../../storage/sqlite"
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
import * as Domain from "../domain"
import { Mailbox } from "../mailbox"
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
        Effect.map(([row]) =>
          row ? Schema.decodeUnknownSync(DeliveryJson)(row.body) : undefined
        )
      )
  const task = (id: string) =>
    db
      .use((orm) => q(orm.select().from(taskTable).where(eq(taskTable.id, id))))
      .pipe(
        Effect.flatMap(([row]) =>
          row
            ? Effect.sync(() => Schema.decodeUnknownSync(TaskJson)(row.body))
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
        Effect.map((rows) =>
          rows.map((row) => Schema.decodeUnknownSync(TaskJson)(row.body))
        )
      )
  const open = (t: Task) =>
    ["accepted", "running", "waiting", "cancelling"].includes(t.status)
  const selectedTasks = () =>
    allTasks().pipe(
      Effect.map((tasks) => {
        const selected = new Set(
          [
            ...tasks.filter(
              (t) => open(t) || (t.direction === "outgoing" && !t.resumed)
            ),
            ...tasks.filter(
              (t) => !open(t) && !(t.direction === "outgoing" && !t.resumed)
            ),
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
  const finish = (t: Task, outcome: Outcome, now: number) =>
    Effect.gen(function* () {
      const result = yield* decide(() => Domain.taskResult(t, outcome, now))
      yield* put(result.envelope, now)
      yield* saveTask(result.task)
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
    enqueue: (raw, now) =>
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
          yield* decide(() => Domain.requireTimely(e, now, "Task"))
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
    accept: (raw, now) =>
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
          yield* decide(() => Domain.requireTimely(e, now, "Message"))
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
              yield* finish(
                { ...t, cancelRequested: true },
                { status: "cancelled", text: "Cancelled before execution." },
                now
              )
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
                Domain.receiveCancellation(priorTask, e)
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
                    ["accepted", "running", "cancelling"].includes(t.status)) ||
                  (t.direction === "outgoing" && !t.resumed)
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
          yield* saveTask(Domain.consumeResult(t))
        })
      ),
    discard: (id) =>
      atomic(() =>
        Effect.gen(function* () {
          const t = yield* task(id)
          if (Domain.resumable(t)) yield* saveTask(Domain.consumeResult(t))
        })
      ),
    deliveries: () =>
      atomic(() =>
        Effect.gen(function* () {
          const selected = new Set((yield* selectedTasks()).map((t) => t.id))
          const rows = yield* db.use((orm) =>
            q(orm.select().from(outbox).orderBy(desc(outbox.sequence)))
          )
          return rows
            .map((row) => Schema.decodeUnknownSync(DeliveryJson)(row.body))
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
          const d = Schema.decodeUnknownSync(DeliveryJson)(row.body),
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
    claimTask: (now) =>
      atomic(() =>
        Effect.gen(function* () {
          const [row] = yield* db.use((orm) =>
            q(
              orm
                .select()
                .from(taskTable)
                .where(
                  and(
                    eq(taskTable.direction, "incoming"),
                    or(
                      inArray(taskTable.status, ["accepted", "cancelling"]),
                      and(
                        eq(taskTable.status, "running"),
                        or(
                          lte(taskTable.lease_until, now),
                          lte(taskTable.deadline, now)
                        )
                      )
                    )
                  )
                )
                .orderBy(taskTable.sequence)
                .limit(1)
            )
          )
          if (!row) return undefined
          const t = Schema.decodeUnknownSync(TaskJson)(row.body),
            claimed = yield* decide(() => Domain.claimTask(t, now))
          yield* saveTask(claimed)
          return claimed
        })
      ),
    finish: (id, revision, outcome, now) =>
      atomic(() =>
        Effect.gen(function* () {
          const t = yield* task(id)
          yield* decide(() => Domain.requireFinish(t, revision, outcome, now))
          yield* finish(t, outcome, now)
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
    retry: (id, now) =>
      atomic(() =>
        Effect.gen(function* () {
          const d = yield* delivery(id)
          if (!d)
            return yield* failure(
              "not_found",
              "Message unavailable in this bot."
            )
          const transition = yield* decide(() => Domain.retryDelivery(d, now))
          if (!transition) return
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
            if (
              t.direction === "incoming" &&
              ["accepted", "running", "cancelling"].includes(t.status)
            )
              times.push(
                t.status === "running"
                  ? Math.min(t.leaseUntil ?? Infinity, t.request.deadline)
                  : 0
              )
            if (
              t.direction === "outgoing" &&
              [
                "completed",
                "failed",
                "expired",
                "cancelled",
                "awaiting_input",
              ].includes(t.status) &&
              !t.resumed
            )
              times.push(0)
            if (t.direction === "outgoing" && open(t))
              times.push(t.request.deadline)
          }
          return times.length ? Math.min(...times) : undefined
        })
      ),
  })
  const initialize = Effect.succeed(service)
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
