import { and, asc, count, desc, eq, inArray } from "drizzle-orm"
import { Effect, Schema } from "effect"

import { replyComplete, type ReplyProgress } from "../../replies/contracts"
import {
  mapSqliteError,
  type Sqlite,
  type EffectSqliteDatabase,
} from "../../storage/sqlite"
import {
  EmailSettings,
  EmailRecord,
  EmailRejected,
  EmailStorageError,
  EMAIL_MAX_PENDING,
  EMAIL_MAX_RECORDS,
  EMAIL_MAX_RETRIES,
  type ConfigureEmail,
  type IncomingEmail,
  type EmailDelivery,
  type EmailFailure,
} from "../contracts"
import { emailSettings, emailMessages, emailRetries } from "./schema"

const pending = ["queued", "waiting", "sending"] as const
export class EmailStore {
  constructor(readonly db: Sqlite) {}
  private query<A, E, R>(
    body: (orm: EffectSqliteDatabase) => Effect.Effect<A, E, R>
  ) {
    return mapSqliteError(
      this.db.use(body),
      () => new EmailStorageError({ operation: "query" })
    )
  }
  private atomic<A, E, R>(body: () => Effect.Effect<A, E, R>) {
    return mapSqliteError(
      this.db.transaction(body),
      () => new EmailStorageError({ operation: "transaction" })
    )
  }
  settings() {
    return this.query((orm) =>
      orm.select().from(emailSettings).limit(1).get()
    ).pipe(
      Effect.map((row) =>
        row
          ? Schema.decodeUnknownSync(EmailSettings)(row)
          : { enabled: true, revision: 0, generation: 1, operationId: "" }
      )
    )
  }
  configure(input: ConfigureEmail) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const current = yield* this.settings()
        if (current.operationId === input.operationId) {
          if (
            current.enabled !== input.enabled ||
            current.revision !== input.revision + 1
          )
            return yield* new EmailRejected({
              message: "This request belongs to different email settings.",
            })
          return current
        }
        if (current.revision !== input.revision)
          return yield* new EmailRejected({
            message: "Email settings changed. Reload before saving.",
          })
        const next = {
          ...current,
          enabled: input.enabled,
          revision: current.revision + 1,
          generation:
            current.generation + (input.enabled && !current.enabled ? 1 : 0),
          operationId: input.operationId,
        }
        yield* this.query((orm) =>
          orm
            .insert(emailSettings)
            .values({ id: 1, ...next })
            .onConflictDoUpdate({ target: emailSettings.id, set: next })
        )
        if (!input.enabled)
          yield* this.query((orm) =>
            orm
              .update(emailMessages)
              .set({
                state: "cancelled",
                error: "Email was disabled. The conversation remains in Pi.",
              })
              .where(inArray(emailMessages.state, ["queued", "waiting"]))
          )
        return next
      })
    )
  }
  get(id: string) {
    return this.query((orm) =>
      orm.select().from(emailMessages).where(eq(emailMessages.id, id)).get()
    ).pipe(
      Effect.map((row) =>
        row ? Schema.decodeUnknownSync(EmailRecord)(row) : undefined
      )
    )
  }
  list() {
    return this.query((orm) =>
      orm
        .select()
        .from(emailMessages)
        .orderBy(desc(emailMessages.createdAt))
        .limit(30)
    ).pipe(Effect.map(Schema.decodeUnknownSync(Schema.Array(EmailRecord))))
  }
  pending() {
    return this.query((orm) =>
      orm
        .select()
        .from(emailMessages)
        .where(inArray(emailMessages.state, pending))
        .orderBy(asc(emailMessages.createdAt))
        .limit(80)
    ).pipe(Effect.map(Schema.decodeUnknownSync(Schema.Array(EmailRecord))))
  }
  receive(input: IncomingEmail, generation: number) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const settings = yield* this.settings()
        if (!settings.enabled || settings.generation !== generation)
          return yield* new EmailRejected({
            message: "Email is disabled or this address was revoked.",
          })
        const previous = yield* this.get(input.id)
        if (previous) {
          if (previous.fingerprint !== input.fingerprint)
            return yield* new EmailRejected({
              message:
                "This Message-ID was already used for different content.",
            })
          return false
        }
        const [totals] = yield* this.query((orm) =>
          orm.select({ total: count() }).from(emailMessages)
        )
        if (
          totals!.total >= EMAIL_MAX_RECORDS ||
          (yield* this.pending()).length >= EMAIL_MAX_PENDING
        )
          return yield* new EmailRejected({
            message: "This agent's email inbox is full. Open Pi to review it.",
          })
        yield* this.query((orm) =>
          orm
            .insert(emailMessages)
            .values({ ...input, state: "queued", createdAt: Date.now() })
        )
        return true
      })
    )
  }
  notice(parent: EmailRecord, key: string, reply: string) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        if (!(yield* this.settings()).enabled) return
        yield* this.query((orm) =>
          orm
            .insert(emailMessages)
            .values({
              id: crypto.randomUUID(),
              fingerprint: parent.fingerprint,
              messageId: parent.messageId,
              sender: parent.sender,
              recipient: parent.recipient,
              subject: parent.subject,
              body: "Approval notification",
              references: parent.references,
              files: [],
              purpose: "notification",
              noticeKey: key,
              state: "waiting",
              reply,
              createdAt: Date.now(),
            })
            .onConflictDoNothing()
        )
      })
    )
  }
  /** Fence revocation and the ledger decision together in this actor database. */
  decide<A, E>(
    id: string,
    allowed: () => Effect.Effect<boolean, EmailFailure>,
    body: () => Effect.Effect<A, E>
  ) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const current = yield* this.get(id)
        if (
          !(yield* this.settings()).enabled ||
          current?.state !== "queued" ||
          !(yield* allowed())
        )
          return yield* new EmailRejected({
            message:
              "Email was disabled or this request is no longer active. Review the action in Pi.",
          })
        return yield* body()
      })
    )
  }
  update(
    id: string,
    from: EmailDelivery,
    state: EmailDelivery,
    details: {
      reply?: string
      delivery?: ReplyProgress
      error?: string | null
      providerId?: string | null
    } = {}
  ) {
    return this.query((orm) =>
      orm
        .update(emailMessages)
        .set({ state, ...details })
        .where(and(eq(emailMessages.id, id), eq(emailMessages.state, from)))
        .returning({ id: emailMessages.id })
    ).pipe(Effect.map((rows) => rows.length > 0))
  }
  recover() {
    return Effect.gen({ self: this }, function* () {
      for (const record of yield* this.pending()) {
        if (record.state !== "sending") continue
        const complete = replyComplete(record.delivery)
        yield* this.update(
          record.id,
          "sending",
          complete ? "sent" : "uncertain",
          {
            providerId: complete
              ? (record.delivery!.receipts.at(-1) ?? null)
              : null,
            error: complete
              ? null
              : "Sending was interrupted. Check the destination before retrying.",
          }
        )
      }
    })
  }

  /** Revalidate channel and agent authority in the same local transaction as
   * the send intent. The supplied authority read must use this actor database. */
  claim(
    id: string,
    reply: string,
    allowed: () => Effect.Effect<boolean, EmailFailure>,
    delivery?: ReplyProgress,
    from: "waiting" | "sending" = "waiting"
  ) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const settings = yield* this.settings()
        if (
          !settings.enabled ||
          (delivery && delivery.generation !== settings.generation) ||
          !(yield* allowed())
        ) {
          yield* this.update(id, from, "cancelled", {
            error:
              "Email is disabled or the agent is archived. The conversation remains in Pi.",
          })
          return false
        }
        return yield* this.update(id, from, "sending", {
          reply,
          ...(delivery ? { delivery } : {}),
          error: null,
        })
      })
    )
  }
  retry(id: string, acknowledgeDuplicateRisk: boolean, operationId: string) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const previous = yield* this.query((orm) =>
          orm
            .select()
            .from(emailRetries)
            .where(eq(emailRetries.operationId, operationId))
            .get()
        )
        if (previous) {
          if (
            previous.emailId !== id ||
            previous.acknowledgeDuplicateRisk !== acknowledgeDuplicateRisk
          )
            return yield* new EmailRejected({
              message:
                "This retry request belongs to a different reply or acknowledgement.",
            })
          return
        }
        if (!(yield* this.settings()).enabled)
          return yield* new EmailRejected({
            message: "Enable email before retrying a reply.",
          })
        const row = yield* this.get(id)
        if (!row || !["failed", "uncertain"].includes(row.state))
          return yield* new EmailRejected({
            message: "This reply cannot be retried.",
          })
        if (row.state === "uncertain" && !acknowledgeDuplicateRisk)
          return yield* new EmailRejected({
            message:
              "Check your inbox and acknowledge that sending again may create a duplicate.",
          })
        const [attempts] = yield* this.query((orm) =>
          orm
            .select({ total: count() })
            .from(emailRetries)
            .where(eq(emailRetries.emailId, id))
        )
        if (attempts!.total >= EMAIL_MAX_RETRIES)
          return yield* new EmailRejected({
            message:
              "This reply has reached its retry limit. Open the conversation in Pi.",
          })
        yield* this.query((orm) =>
          orm
            .insert(emailRetries)
            .values({ operationId, emailId: id, acknowledgeDuplicateRisk })
        )
        yield* this.query((orm) =>
          orm
            .update(emailMessages)
            .set({
              state: "waiting",
              error: null,
            })
            .where(
              and(eq(emailMessages.id, id), eq(emailMessages.state, row.state))
            )
        )
      })
    )
  }
}
