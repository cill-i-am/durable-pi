import { asc, count, desc, eq, inArray } from "drizzle-orm"
import { Clock, Effect, Schema } from "effect"

import {
  ReplyOwnership,
  REPLY_LEASE_MS,
  type ReplyProgress,
  type ReplyLease,
  type ReplyWork,
} from "../../replies/contracts"
import {
  advanceReplyMessage,
  newReplyMessage,
  type ReplyMessageEvent,
} from "../../replies/message.machine"
import {
  mapSqliteError,
  type Sqlite,
  type EffectSqliteDatabase,
} from "../../storage/sqlite"
import {
  configureEmail,
  readEmailConfiguration,
} from "../configuration.machine"
import {
  EmailSettings,
  EmailRecord,
  EmailRejected,
  EmailUnavailable,
  EmailStorageError,
  EMAIL_MAX_PENDING,
  EMAIL_MAX_RECORDS,
  EMAIL_MAX_RETRIES,
  type ConfigureEmail,
  type IncomingEmail,
  type EmailFailure,
} from "../contracts"
import { emailSettings, emailMessages, emailRetries } from "./schema"

const StoredEmail = Schema.Struct({ ...EmailRecord.fields, ...ReplyOwnership })
const pending = ["queued", "waiting", "sending"] as const
export class EmailStore {
  constructor(readonly db: Sqlite) {}
  private query<A, E, R>(
    body: (orm: EffectSqliteDatabase) => Effect.Effect<A, E, R>
  ) {
    return mapSqliteError(
      this.db.use(body),
      (cause) => new EmailStorageError({ operation: "query", cause })
    )
  }
  private atomic<A, E, R>(body: () => Effect.Effect<A, E, R>) {
    return mapSqliteError(
      this.db.transaction(body),
      (cause) => new EmailStorageError({ operation: "transaction", cause })
    )
  }
  private readSettings() {
    return this.query((orm) =>
      orm.select().from(emailSettings).limit(1).get()
    ).pipe(Effect.map(readEmailConfiguration))
  }
  settings() {
    return this.readSettings().pipe(
      Effect.map(Schema.decodeUnknownSync(EmailSettings))
    )
  }
  configure(input: ConfigureEmail) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const current = yield* this.readSettings()
        const { record: next, commands } = configureEmail(current, input)
        for (const command of commands)
          if (command.type === "rejected")
            return yield* new EmailRejected({ message: command.message })
        if (next.revision === current.revision)
          return Schema.decodeUnknownSync(EmailSettings)(next)
        yield* this.query((orm) =>
          orm
            .insert(emailSettings)
            .values({ id: 1, ...next })
            .onConflictDoUpdate({ target: emailSettings.id, set: next })
        )
        for (const command of commands)
          if (command.type === "cancel-pending")
            for (const record of yield* this.pending())
              yield* this.cancel(
                record.id,
                "Email was disabled. The conversation remains in Pi."
              )
        return Schema.decodeUnknownSync(EmailSettings)(next)
      })
    )
  }
  private readCurrent(id: string) {
    return this.query((orm) =>
      orm.select().from(emailMessages).where(eq(emailMessages.id, id)).get()
    ).pipe(
      Effect.map((row) =>
        row ? Schema.decodeUnknownSync(StoredEmail)(row) : undefined
      )
    )
  }
  get(id: string) {
    return this.readCurrent(id).pipe(
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
    ).pipe(
      Effect.map((rows) =>
        rows.map((row) =>
          Schema.decodeUnknownSync(EmailRecord)(
            Schema.decodeUnknownSync(StoredEmail)(row)
          )
        )
      )
    )
  }
  pending() {
    return this.query((orm) =>
      orm
        .select()
        .from(emailMessages)
        .where(inArray(emailMessages.state, pending))
        .orderBy(asc(emailMessages.createdAt))
        .limit(80)
    ).pipe(
      Effect.map((rows) =>
        rows.map((row) =>
          Schema.decodeUnknownSync(EmailRecord)(
            Schema.decodeUnknownSync(StoredEmail)(row)
          )
        )
      )
    )
  }
  receive(input: IncomingEmail, generation: number, discoveryDeadline: number) {
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
        if ((yield* Clock.currentTimeMillis) >= discoveryDeadline)
          return yield* new EmailUnavailable()
        yield* this.query((orm) =>
          orm.insert(emailMessages).values({
            ...input,
            ...newReplyMessage("", false, false, null, discoveryDeadline),
            state: "queued",
            createdAt: Date.now(),
          })
        )
        return true
      })
    )
  }
  notice(
    parent: EmailRecord,
    key: string,
    reply: string,
    discoveryDeadline: number
  ) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        if (!(yield* this.settings()).enabled) return
        if ((yield* this.readCurrent(parent.id))?.state !== "waiting") return
        if ((yield* Clock.currentTimeMillis) >= discoveryDeadline)
          return yield* new EmailUnavailable()
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
              ...newReplyMessage(reply, true, false, null, discoveryDeadline),
              state: "waiting",
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
  private change(id: string, event: ReplyMessageEvent) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const current = yield* this.readCurrent(id)
        if (!current) return false
        const next = advanceReplyMessage(
          { ...current, delivery: current.delivery ?? null },
          event
        )
        if (next.revision === current.revision) return false
        if (next.state === "expired")
          throw new Error("Email cannot acquire a WhatsApp reply-window state")
        const state = next.state
        yield* this.query((orm) =>
          orm
            .update(emailMessages)
            .set({ ...next, state })
            .where(eq(emailMessages.id, id))
        )
        return true
      })
    )
  }
  prepared(id: string, reply = "", revision?: number) {
    return this.change(id, { type: "PREPARED", reply, revision })
  }
  cancel(id: string, error: string) {
    return this.change(id, { type: "CANCEL", error })
  }
  checkpoint(id: string, attemptId: string, delivery: ReplyProgress) {
    return this.change(id, { type: "CHECKPOINT", attemptId, delivery })
  }
  finish(
    id: string,
    attemptId: string,
    state: "sent" | "failed" | "uncertain",
    providerId: string | null,
    error: string | null
  ) {
    return this.change(id, {
      type: "FINISH",
      attemptId,
      state,
      providerId,
      error,
    })
  }
  recoverAttempt(id: string, attemptId: string) {
    return this.change(id, {
      type: "RECOVER",
      now: 0,
      force: true,
      attemptId,
      error: "Sending was interrupted. Check the destination before retrying.",
    })
  }
  recover(force = true) {
    return Effect.gen({ self: this }, function* () {
      const now = yield* Clock.currentTimeMillis
      for (const record of yield* this.pending())
        yield* this.change(record.id, {
          type: "RECOVER",
          now,
          force,
          attemptId: null,
          error:
            "Sending was interrupted. Check the destination before retrying.",
        })
    })
  }
  /** Lifecycle exhausted its finite job attempts. No new provider attempt is
   * authorized; active send leases retain their deadline and ownership. */
  exhaustRecovery(eligible?: () => boolean, expiredOnly = false) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const now = yield* Clock.currentTimeMillis
        if (eligible && !eligible()) return
        for (const record of yield* this.pending())
          yield* this.change(record.id, {
            type: "RECOVERY_EXHAUSTED",
            expiredOnly,
            now,
            error:
              "Reply processing could not finish. Review the conversation and retry explicitly; check the destination before retrying an unconfirmed send.",
          })
      })
    )
  }
  /** Refuse an expired orphan before it can use an unrelated message's wake. */
  getPendingWork(id: string) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        yield* this.change(id, {
          type: "WORK_CHECKED",
          now: yield* Clock.currentTimeMillis,
          error:
            "Reply processing stopped before it could finish. Review the conversation and retry explicitly.",
        })
        const current = yield* this.readCurrent(id)
        if (
          !current ||
          (current.state !== "queued" && current.state !== "waiting") ||
          current.workDeadline === null
        )
          return undefined
        return {
          revision: current.revision,
          state: current.state,
          deadline: current.workDeadline,
          record: Schema.decodeUnknownSync(EmailRecord)(current),
        } satisfies ReplyWork<EmailRecord>
      })
    )
  }
  /** The caller must prearm this deadline after a successful owned pass. */
  renewWork(id: string, revision: number, deadline: number) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const now = yield* Clock.currentTimeMillis
        yield* this.change(id, {
          type: "WORK_CHECKED",
          now,
          error:
            "Reply processing stopped before it could finish. Review the conversation and retry explicitly.",
        })
        return yield* this.change(id, {
          type: "WORK_RENEWED",
          revision,
          deadline,
          now,
        })
      })
    )
  }
  nextRecovery() {
    return Effect.gen({ self: this }, function* () {
      const now = yield* Clock.currentTimeMillis
      const rows = yield* this.query((orm) =>
        orm
          .select({
            state: emailMessages.state,
            sendDeadline: emailMessages.sendDeadline,
            workDeadline: emailMessages.workDeadline,
          })
          .from(emailMessages)
          .where(inArray(emailMessages.state, pending))
      )
      return rows.length
        ? Math.max(
            now,
            Math.min(
              ...rows.map(
                (row) =>
                  (row.state === "sending"
                    ? row.sendDeadline
                    : row.workDeadline) ?? now
              )
            )
          )
        : undefined
    })
  }

  /** Revalidate channel and agent authority in the same local transaction as
   * the send intent. The supplied authority read must use this actor database. */
  claim(
    id: string,
    reply: string,
    allowed: () => Effect.Effect<boolean, EmailFailure>,
    delivery?: ReplyProgress,
    from: "waiting" | "sending" = "waiting",
    lease?: ReplyLease
  ) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const settings = yield* this.settings()
        const authorized =
          settings.enabled &&
          (!delivery || delivery.generation === settings.generation) &&
          (yield* allowed())
        const now = yield* Clock.currentTimeMillis
        const changed = yield* this.change(id, {
          type: "CLAIM",
          from,
          attemptId: lease?.attemptId ?? crypto.randomUUID(),
          deadline: lease?.deadline ?? now + REPLY_LEASE_MS,
          now,
          reply,
          delivery: delivery ?? null,
          authorized,
          expired: false,
          error:
            "Email is disabled or the agent is archived. The conversation remains in Pi.",
        })
        return changed && authorized
      })
    )
  }
  retry(
    id: string,
    acknowledgeDuplicateRisk: boolean,
    operationId: string,
    discoveryDeadline: number
  ) {
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
        if ((yield* Clock.currentTimeMillis) >= discoveryDeadline)
          return yield* new EmailUnavailable()
        yield* this.query((orm) =>
          orm
            .insert(emailRetries)
            .values({ operationId, emailId: id, acknowledgeDuplicateRisk })
        )
        yield* this.change(id, {
          type: "RETRY",
          deadline: discoveryDeadline,
          waiting: !!(row.reply || row.delivery),
          acknowledgeDuplicateRisk,
        })
      })
    )
  }
}
