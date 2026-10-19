import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  lt,
  lte,
  min,
  notExists,
  or,
  sql,
} from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"
import { Effect, Schema } from "effect"

import { chatTurns } from "../../conversations/adapters/schema"
import { increment } from "../../storage/expressions"
import {
  mapSqliteError,
  type Sqlite,
  type SqliteOrm,
} from "../../storage/sqlite"
import { Message, fail, type Address } from "../contracts"
import { agentMessages as t, agentSessionLimits as limits } from "./schema"

type Row = typeof t.$inferSelect
const MessageJson = Schema.fromJsonString(Message)
const decode = (row: Row) => ({
  ...row,
  message: Schema.decodeUnknownSync(MessageJson)(row.payload),
})
const accepted = eq(t.state, "accepted")
const addressed = (from: Address, to: Address) =>
  and(
    eq(t.sender_session, from.sessionId),
    eq(t.sender_agent, from.agentId),
    eq(t.recipient_session, to.sessionId),
    eq(t.recipient_agent, to.agentId)
  )
const head = (orm: SqliteOrm) => {
  const prior = alias(t, "prior")
  return notExists(
    orm
      .select()
      .from(prior)
      .where(
        and(
          lt(prior.sequence, t.sequence),
          eq(prior.state, "accepted"),
          eq(prior.recipient_session, t.recipient_session),
          eq(prior.recipient_agent, t.recipient_agent)
        )
      )
  )
}

/** One persisted record owns delivery and its receipt. Native request IDs deduplicate replay. */
export class CoordinationStore {
  constructor(private readonly db: Sqlite) {}
  private query<T, E, R>(body: (orm: SqliteOrm) => Effect.Effect<T, E, R>) {
    return mapSqliteError(this.db.use(body), () =>
      fail("unavailable", "Agent message storage is unavailable.")
    )
  }
  atomic<T, E, R>(body: () => Effect.Effect<T, E, R>) {
    return mapSqliteError(this.db.transaction(body), () =>
      fail("unavailable", "Agent message storage is unavailable.")
    )
  }
  operation(id: string) {
    return this.query((orm) =>
      orm.select().from(t).where(eq(t.operation_id, id)).limit(1)
    ).pipe(Effect.map((rows) => (rows[0] ? decode(rows[0]) : undefined)))
  }
  get(id: string) {
    return this.query((orm) =>
      orm.select().from(t).where(eq(t.id, id)).limit(1)
    ).pipe(Effect.map((rows) => (rows[0] ? decode(rows[0]) : undefined)))
  }
  private capacity(message: Message) {
    return Effect.gen({ self: this }, function* () {
      for (const session of new Set([
        message.from.sessionId,
        message.to.sessionId,
      ])) {
        if (yield* this.closed(session))
          return yield* fail("closed", "This session has stopped.")
        const rows = yield* this.query((orm) =>
          orm
            .select({ n: count() })
            .from(t)
            .where(
              or(
                eq(t.sender_session, session),
                eq(t.recipient_session, session)
              )
            )
        )
        if (rows[0]!.n >= 64)
          return yield* fail(
            "limit",
            "This session reached its 64-message coordination limit."
          )
      }
      const rows = yield* this.query((orm) =>
        orm.select({ n: count() }).from(t)
      )
      if (rows[0]!.n >= 10000)
        return yield* fail("limit", "This bot's message archive is full.")
    })
  }
  accept(message: Message) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const old = yield* this.operation(message.operationId)
        if (old) {
          const identity = (value: Message) =>
            JSON.stringify([
              value.from,
              value.to,
              value.text,
              value.replyTo ?? null,
            ])
          if (identity(old.message) !== identity(message))
            return yield* fail(
              "conflict",
              "Message operation belongs to different content or participants."
            )
          return old
        }
        yield* this.capacity(message)
        const rows = yield* this.query((orm) =>
          orm
            .insert(t)
            .values({
              id: message.id,
              operation_id: message.operationId,
              sender_session: message.from.sessionId,
              sender_agent: message.from.agentId,
              recipient_session: message.to.sessionId,
              recipient_agent: message.to.agentId,
              payload: Schema.encodeSync(MessageJson)(message),
              state: "accepted",
              retry_at: message.createdAt,
            })
            .returning()
        )
        return decode(rows[0]!)
      })
    )
  }
  pending(now: number) {
    return this.query((orm) =>
      orm
        .select()
        .from(t)
        .where(and(accepted, lte(t.retry_at, now), head(orm)))
        .orderBy(asc(t.sequence))
        .limit(20)
    ).pipe(Effect.map((rows) => rows.map(decode)))
  }
  nextWake() {
    return this.query((orm) =>
      orm
        .select({ next: min(t.retry_at) })
        .from(t)
        .where(and(accepted, head(orm)))
    ).pipe(Effect.map((rows) => rows[0]?.next ?? undefined))
  }
  delivered(id: string) {
    return this.query((orm) =>
      orm
        .update(t)
        .set({ state: "delivered", error: null })
        .where(and(eq(t.id, id), accepted))
    ).pipe(Effect.asVoid)
  }
  failed(id: string, error: string) {
    return this.query((orm) =>
      orm
        .update(t)
        .set({ state: "failed", error })
        .where(and(eq(t.id, id), accepted))
    ).pipe(Effect.asVoid)
  }
  retry(id: string, now: number) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const row = yield* this.get(id)
        if (!row) return
        if (row.attempts >= 7)
          return yield* this.failed(
            id,
            "Delivery could not be confirmed after eight attempts."
          )
        yield* this.query((orm) =>
          orm
            .update(t)
            .set({
              attempts: increment(t.attempts),
              retry_at: now + Math.min(30000, 1000 * 2 ** row.attempts),
            })
            .where(and(eq(t.id, id), accepted))
        )
      })
    )
  }
  last(from: Address, to: Address) {
    return this.query((orm) =>
      orm
        .select()
        .from(t)
        .where(and(addressed(from, to), eq(t.state, "delivered")))
        .orderBy(desc(t.sequence))
        .limit(1)
    ).pipe(Effect.map((rows) => (rows[0] ? decode(rows[0]).message : null)))
  }
  lastSent(from: Address, to: Address) {
    return this.query((orm) =>
      orm
        .select()
        .from(t)
        .where(addressed(from, to))
        .orderBy(desc(t.sequence))
        .limit(1)
    ).pipe(
      Effect.map((rows) =>
        rows[0]
          ? { id: rows[0].id, status: rows[0].state, error: rows[0].error }
          : null
      )
    )
  }
  childRequests(id: number) {
    return this.query((orm) =>
      orm
        .select({ id: t.id })
        .from(t)
        .where(
          and(
            inArray(t.state, ["accepted", "delivered"]),
            eq(t.recipient_agent, String(id))
          )
        )
        .orderBy(asc(t.sequence))
    ).pipe(Effect.map((rows) => rows.map((row) => row.id)))
  }
  closed(id: string) {
    return this.query((orm) =>
      orm
        .select({ closed: limits.closed })
        .from(limits)
        .where(eq(limits.id, id))
        .limit(1)
    ).pipe(Effect.map((rows) => rows[0]?.closed ?? false))
  }
  close(id: string) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        yield* this.query((orm) =>
          orm
            .insert(limits)
            .values({ id, closed: true })
            .onConflictDoUpdate({ target: limits.id, set: { closed: true } })
        )
        yield* this.query((orm) =>
          orm
            .update(t)
            .set({ state: "failed", error: "Session stopped." })
            .where(
              and(
                accepted,
                or(eq(t.sender_session, id), eq(t.recipient_session, id))
              )
            )
        )
      })
    )
  }
  /** Membership revocation fences existing native roots and their queued mail
   * in one transaction, without loading historical prompts into the actor. */
  closeAll() {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        yield* this.query((orm) =>
          orm.run(sql`
          INSERT INTO ${limits} (id, closed, requests)
          SELECT ${chatTurns.id}, 1, 0 FROM ${chatTurns}
          WHERE ${chatTurns.parent_id} IS NULL AND ${chatTurns.session_id} IS NOT NULL
          ON CONFLICT (id) DO UPDATE SET closed = 1
        `)
        )
        yield* this.query((orm) =>
          orm
            .update(t)
            .set({ state: "failed", error: "Membership changed." })
            .where(accepted)
        )
      })
    )
  }
  request(turnId: string) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const rows = yield* this.query((orm) =>
          orm.select().from(limits).where(eq(limits.id, turnId)).limit(1)
        )
        if ((rows[0]?.requests ?? 0) >= 12)
          return yield* fail(
            "limit",
            "This message continuation reached its model-request limit."
          )
        yield* this.query((orm) =>
          orm
            .insert(limits)
            .values({ id: turnId, requests: 1 })
            .onConflictDoUpdate({
              target: limits.id,
              set: { requests: increment(limits.requests) },
            })
        )
      })
    )
  }
}
