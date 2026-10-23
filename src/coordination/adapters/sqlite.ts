import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  min,
  notExists,
  or,
} from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"
import { Effect, Schema } from "effect"

import { chatTurns } from "../../conversations/adapters/schema"
import {
  mapSqliteError,
  type Sqlite,
  type SqliteOrm,
} from "../../storage/sqlite"
import { Message, fail, type Address } from "../contracts"
import {
  advanceMessage,
  MessageControl,
  messageStatus,
  type MessageEvent,
} from "../message.machine"
import { advanceSession } from "../session.machine"
import { agentMessages as t, agentSessionLimits as limits } from "./schema"

type Row = typeof t.$inferSelect
const MessageJson = Schema.fromJsonString(Message)
const decode = (row: Row) => {
  const control = Schema.decodeUnknownSync(MessageControl)(row)
  if (messageStatus(control) !== row.state)
    throw new Error(
      "Coordination message projection does not match its lifecycle"
    )
  if (
    (control.phase === "dispatching") !== (control.attempt_id !== null) &&
    control.phase !== "unconfirmed"
  )
    throw new Error(
      "Coordination message has an inconsistent dispatch identity"
    )
  return {
    ...row,
    ...control,
    message: Schema.decodeUnknownSync(MessageJson)(row.payload),
  }
}
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
  accept(message: Message, discoveryDeadline: number, now = Date.now) {
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
        if (!Number.isFinite(discoveryDeadline) || discoveryDeadline <= now())
          return yield* fail(
            "unavailable",
            "Agent message discovery must be armed before acceptance."
          )
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
        .where(and(eq(t.phase, "pending"), lte(t.retry_at, now), head(orm)))
        .orderBy(asc(t.sequence))
        .limit(20)
    ).pipe(Effect.map((rows) => rows.map(decode)))
  }
  nextWake() {
    return this.query((orm) =>
      orm
        .select({ next: min(t.retry_at) })
        .from(t)
        .where(and(eq(t.phase, "pending"), head(orm)))
    ).pipe(Effect.map((rows) => rows[0]?.next ?? undefined))
  }
  private advance(id: string, event: MessageEvent, revision?: number) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const row = yield* this.get(id)
        if (!row || (revision !== undefined && row.revision !== revision))
          return
        const next = advanceMessage(row, row.message.deadline, event)
        if (!next) return
        const rows = yield* this.query((orm) =>
          orm
            .update(t)
            .set({ ...next, state: messageStatus(next) })
            .where(and(eq(t.id, id), eq(t.revision, row.revision)))
            .returning()
        )
        return rows[0] ? decode(rows[0]) : undefined
      })
    )
  }
  claim(id: string, revision: number, now: number, attempt: string) {
    return this.advance(id, { type: "CLAIM", now, attempt }, revision)
  }
  owns(id: string, attempt: string) {
    return this.get(id).pipe(
      Effect.map(
        (row) => row?.phase === "dispatching" && row.attempt_id === attempt
      )
    )
  }
  delivered(id: string, attempt: string) {
    return this.advance(id, { type: "ACCEPTED", attempt }).pipe(Effect.asVoid)
  }
  failed(id: string, attempt: string, error: string) {
    return this.advance(id, { type: "REJECTED", attempt, error }).pipe(
      Effect.asVoid
    )
  }
  retry(id: string, attempt: string, now: number) {
    return this.advance(id, { type: "RETRY", attempt, now }).pipe(Effect.asVoid)
  }
  /** Only cold activation calls this. Warm owners are never stolen on a timer. */
  restore(now: number) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const rows = yield* this.query((orm) =>
          orm.select().from(t).where(eq(t.phase, "dispatching"))
        )
        for (const row of rows)
          yield* this.advance(row.id, { type: "RESTORE", now }, row.revision)
      })
    )
  }
  exhaust(current: () => boolean) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        if (!current()) return
        const rows = yield* this.query((orm) =>
          orm.select().from(t).where(accepted)
        )
        for (const row of rows)
          yield* this.advance(
            row.id,
            {
              type: "EXHAUST",
              error:
                "Agent message recovery is unconfirmed. Retry from the original session.",
            },
            row.revision
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
  private closeSession(id: string) {
    return Effect.gen({ self: this }, function* () {
      const rows = yield* this.query((orm) =>
        orm.select().from(limits).where(eq(limits.id, id)).limit(1)
      )
      const current = rows[0] ?? { closed: false, requests: 0 }
      const next = advanceSession(current, { type: "CLOSE" })
      if (!next) return
      yield* this.query((orm) =>
        orm
          .insert(limits)
          .values({ id, ...next })
          .onConflictDoUpdate({ target: limits.id, set: next })
      )
    })
  }
  close(id: string) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        yield* this.closeSession(id)
        const rows = yield* this.query((orm) =>
          orm
            .select()
            .from(t)
            .where(
              and(
                accepted,
                or(eq(t.sender_session, id), eq(t.recipient_session, id))
              )
            )
        )
        for (const row of rows)
          yield* this.advance(
            row.id,
            {
              type: "CLOSE",
              error:
                row.phase === "dispatching"
                  ? "Session stopped; message delivery is unconfirmed."
                  : "Session stopped.",
            },
            row.revision
          )
      })
    )
  }
  /** Membership revocation fences existing native roots and their queued mail
   * in one transaction, without loading historical prompts into the actor. */
  closeAll() {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const roots = yield* this.query((orm) =>
          orm
            .select({ id: chatTurns.id })
            .from(chatTurns)
            .where(
              and(isNull(chatTurns.parent_id), isNotNull(chatTurns.session_id))
            )
        )
        for (const root of roots) yield* this.closeSession(root.id)
        const rows = yield* this.query((orm) =>
          orm.select().from(t).where(accepted)
        )
        for (const row of rows)
          yield* this.advance(
            row.id,
            {
              type: "CLOSE",
              error:
                row.phase === "dispatching"
                  ? "Membership changed; message delivery is unconfirmed."
                  : "Membership changed.",
            },
            row.revision
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
        const current = rows[0] ?? { closed: false, requests: 0 }
        const next = advanceSession(current, { type: "REQUEST" })
        if (!next)
          return yield* fail(
            current.closed ? "closed" : "limit",
            current.closed
              ? "This message session has stopped."
              : "This message continuation reached its model-request limit."
          )
        yield* this.query((orm) =>
          orm
            .insert(limits)
            .values({ id: turnId, ...next })
            .onConflictDoUpdate({
              target: limits.id,
              set: next,
            })
        )
      })
    )
  }
}
