import { asc, count, desc, eq, inArray } from "drizzle-orm"
import { Clock, Effect, Schema } from "effect"

import type { AgentId } from "../../agents/domain"
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
  advanceWhatsAppConfiguration,
  readWhatsAppConfiguration,
} from "../configuration.machine"
import {
  WhatsAppSettings,
  WhatsAppRecord,
  WhatsAppRejected,
  WhatsAppUnavailable,
  WhatsAppStorageError,
  WHATSAPP_MAX_PENDING,
  WHATSAPP_MAX_RECORDS,
  WHATSAPP_WINDOW_MS,
  type ConfigureWhatsApp,
  type IncomingWhatsApp,
  type WhatsAppFailure,
} from "../contracts"
import { whatsappSettings, whatsappMessages, whatsappRetries } from "./schema"

const StoredWhatsApp = Schema.Struct({
  ...WhatsAppRecord.fields,
  ...ReplyOwnership,
})
const pending = ["queued", "waiting", "sending"] as const
export class WhatsAppStore {
  constructor(readonly db: Sqlite) {}
  private query<A, E, R>(
    body: (orm: EffectSqliteDatabase) => Effect.Effect<A, E, R>
  ) {
    return mapSqliteError(
      this.db.use(body),
      (cause) => new WhatsAppStorageError({ operation: "query", cause })
    )
  }
  private atomic<A, E, R>(body: () => Effect.Effect<A, E, R>) {
    return mapSqliteError(
      this.db.transaction(body),
      (cause) => new WhatsAppStorageError({ operation: "transaction", cause })
    )
  }
  private readSettings() {
    return this.query((orm) => orm.select().from(whatsappSettings).get()).pipe(
      Effect.map(readWhatsAppConfiguration)
    )
  }
  settings() {
    return this.readSettings().pipe(
      Effect.map(Schema.decodeUnknownSync(WhatsAppSettings))
    )
  }
  configure(input: ConfigureWhatsApp, agentId: AgentId) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const current = yield* this.readSettings()
        const { record: next, commands } = advanceWhatsAppConfiguration(
          current,
          { type: "CONFIGURE", ...input, agentId }
        )
        for (const command of commands)
          if (command.type === "rejected")
            return yield* new WhatsAppRejected({ message: command.message })
        if (next.revision === current.revision)
          return Schema.decodeUnknownSync(WhatsAppSettings)(next)
        yield* this.query((orm) =>
          orm
            .insert(whatsappSettings)
            .values({ id: 1, ...next })
            .onConflictDoUpdate({ target: whatsappSettings.id, set: next })
        )
        for (const command of commands)
          if (command.type === "cancel-pending")
            for (const record of yield* this.pending())
              yield* this.cancel(
                record.id,
                "WhatsApp was disabled. The conversation remains in Pi."
              )
        return Schema.decodeUnknownSync(WhatsAppSettings)(next)
      })
    )
  }
  private readCurrent(id: string) {
    return this.query((orm) =>
      orm
        .select()
        .from(whatsappMessages)
        .where(eq(whatsappMessages.id, id))
        .get()
    ).pipe(
      Effect.map((row) =>
        row ? Schema.decodeUnknownSync(StoredWhatsApp)(row) : undefined
      )
    )
  }
  get(id: string) {
    return this.readCurrent(id).pipe(
      Effect.map((row) =>
        row ? Schema.decodeUnknownSync(WhatsAppRecord)(row) : undefined
      )
    )
  }
  list() {
    return this.query((orm) =>
      orm
        .select()
        .from(whatsappMessages)
        .orderBy(desc(whatsappMessages.createdAt))
        .limit(30)
    ).pipe(
      Effect.map((rows) =>
        rows.map((row) =>
          Schema.decodeUnknownSync(WhatsAppRecord)(
            Schema.decodeUnknownSync(StoredWhatsApp)(row)
          )
        )
      )
    )
  }
  pending() {
    return this.query((orm) =>
      orm
        .select()
        .from(whatsappMessages)
        .where(inArray(whatsappMessages.state, pending))
        .orderBy(asc(whatsappMessages.createdAt))
        .limit(WHATSAPP_MAX_PENDING)
    ).pipe(
      Effect.map((rows) =>
        rows.map((row) =>
          Schema.decodeUnknownSync(WhatsAppRecord)(
            Schema.decodeUnknownSync(StoredWhatsApp)(row)
          )
        )
      )
    )
  }
  receive(
    input: IncomingWhatsApp,
    agentId: AgentId,
    {
      reply = "",
      route,
      outboundFileId = null,
      generation,
    }: {
      reply?: string
      route?: AgentId
      outboundFileId?: string | null
      generation?: number
    } = {},
    discoveryDeadline: number
  ) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const previous = yield* this.get(input.id)
        if (previous) {
          if (previous.fingerprint !== input.fingerprint)
            return yield* new WhatsAppRejected({
              message:
                "This WhatsApp message ID was reused with different content.",
            })
          return false
        }
        const settings = yield* this.readSettings()
        if (!settings.enabled) return false
        if (generation !== undefined && generation !== settings.generation)
          return yield* new WhatsAppRejected({
            message:
              "WhatsApp settings changed while this message was being prepared.",
          })
        const [total] = yield* this.query((orm) =>
          orm.select({ total: count() }).from(whatsappMessages)
        )
        if (
          total!.total >= WHATSAPP_MAX_RECORDS ||
          (yield* this.pending()).length >= WHATSAPP_MAX_PENDING
        )
          return yield* new WhatsAppRejected({
            message: "The WhatsApp inbox is full. Open Pi to review it.",
          })
        if (input.timestamp > Date.now() + 60_000)
          return yield* new WhatsAppRejected({
            message: "Invalid WhatsApp message timestamp.",
          })
        if ((yield* Clock.currentTimeMillis) >= discoveryDeadline)
          return yield* new WhatsAppUnavailable()
        const { record: nextSettings } = advanceWhatsAppConfiguration(
          settings,
          {
            type: "INBOUND",
            timestamp: input.timestamp,
            route: route ?? null,
          }
        )
        yield* this.query((orm) =>
          orm
            .update(whatsappSettings)
            .set(nextSettings)
            .where(eq(whatsappSettings.id, 1))
        )
        const expired =
          Date.now() - Math.max(settings.lastInboundAt, input.timestamp) >=
          WHATSAPP_WINDOW_MS
        yield* this.query((orm) =>
          orm.insert(whatsappMessages).values({
            ...input,
            media: input.media ?? null,
            fileId: null,
            outboundFileId,
            mediaAttempts: 0,
            agentId,
            generation: settings.generation,
            control: !!reply,
            ...newReplyMessage(
              reply,
              !!reply,
              expired,
              expired
                ? "The WhatsApp reply window closed. Open Pi to review this request."
                : null,
              discoveryDeadline
            ),
            createdAt: Date.now(),
          })
        )
        return true
      })
    )
  }
  notice(
    parent: WhatsAppRecord,
    input: IncomingWhatsApp,
    reply: string,
    discoveryDeadline: number
  ) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const current = yield* this.readCurrent(parent.id)
        if (
          current?.state !== "waiting" ||
          current.generation !== parent.generation
        )
          return
        yield* this.receive(
          input,
          parent.agentId,
          { reply, generation: parent.generation },
          discoveryDeadline
        )
      })
    )
  }
  private change(
    id: string,
    event: ReplyMessageEvent,
    details: {
      control?: boolean
      fileId?: string
      mediaAttempts?: number
    } = {}
  ) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const current = yield* this.readCurrent(id)
        if (!current) return false
        const next = advanceReplyMessage(
          { ...current, delivery: current.delivery ?? null },
          event
        )
        if (next.revision === current.revision) return false
        yield* this.query((orm) =>
          orm
            .update(whatsappMessages)
            .set({ ...details, ...next })
            .where(eq(whatsappMessages.id, id))
        )
        return true
      })
    )
  }
  prepared(id: string, reply = "", control = false, revision?: number) {
    return this.change(id, { type: "PREPARED", reply, revision }, { control })
  }
  cancel(id: string, error: string) {
    return this.change(id, { type: "CANCEL", error })
  }
  expire(id: string, error: string, revision?: number) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const settings = yield* this.settings()
        const now = yield* Clock.currentTimeMillis
        return yield* this.change(id, {
          type: "EXPIRE",
          error,
          revision,
          expired: now - settings.lastInboundAt >= WHATSAPP_WINDOW_MS,
        })
      })
    )
  }
  preparationFailed(id: string, revision: number, error: string) {
    return this.change(id, { type: "PREPARATION_FAILED", revision, error })
  }
  saveMedia(id: string, revision: number, fileId: string) {
    return this.change(id, { type: "PREPARATION_SAVED", revision }, { fileId })
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
          record: Schema.decodeUnknownSync(WhatsAppRecord)(current),
        } satisfies ReplyWork<WhatsAppRecord>
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
            state: whatsappMessages.state,
            sendDeadline: whatsappMessages.sendDeadline,
            workDeadline: whatsappMessages.workDeadline,
          })
          .from(whatsappMessages)
          .where(inArray(whatsappMessages.state, pending))
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

  claim(
    record: WhatsAppRecord,
    reply: string,
    active: () => Effect.Effect<boolean, WhatsAppFailure>,
    delivery?: ReplyProgress,
    from: "waiting" | "sending" = "waiting",
    lease?: ReplyLease
  ) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const settings = yield* this.settings()
        const authorized =
          settings.enabled &&
          settings.generation === record.generation &&
          (!delivery || delivery.generation === settings.generation) &&
          (yield* active())
        const now = yield* Clock.currentTimeMillis
        const expired = now - settings.lastInboundAt >= WHATSAPP_WINDOW_MS
        const changed = yield* this.change(record.id, {
          type: "CLAIM",
          from,
          attemptId: lease?.attemptId ?? crypto.randomUUID(),
          deadline: lease?.deadline ?? now + REPLY_LEASE_MS,
          now,
          reply,
          delivery: delivery ?? null,
          authorized,
          expired,
          error: !authorized
            ? "WhatsApp is disabled or the agent is archived. Review this conversation in Pi."
            : "The WhatsApp reply window closed. Send a new WhatsApp message before retrying.",
        })
        return changed && authorized && !expired
      })
    )
  }
  beginMedia(id: string, revision?: number) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const record = yield* this.readCurrent(id)
        if (!record) return undefined
        const changed = yield* this.change(
          id,
          {
            type: "PREPARATION_STARTED",
            revision,
            attempts: record.mediaAttempts,
            limit: 5,
            error:
              "The image could not be prepared after several attempts. Retry or send it again.",
          },
          { mediaAttempts: Math.min(5, record.mediaAttempts + 1) }
        )
        const current = yield* this.readCurrent(id)
        return changed && current?.state === "queued"
          ? current.revision
          : undefined
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
            .from(whatsappRetries)
            .where(eq(whatsappRetries.operationId, operationId))
            .get()
        )
        if (previous) {
          if (
            previous.messageId !== id ||
            previous.acknowledgeDuplicateRisk !== acknowledgeDuplicateRisk
          )
            return yield* new WhatsAppRejected({
              message: "This retry belongs to different inputs.",
            })
          return
        }
        const settings = yield* this.settings()
        if (
          !settings.enabled ||
          Date.now() - settings.lastInboundAt >= WHATSAPP_WINDOW_MS
        )
          return yield* new WhatsAppRejected({
            message: "Enable WhatsApp and send a new message before retrying.",
          })
        const row = yield* this.get(id)
        if (
          !row ||
          row.generation !== settings.generation ||
          !["failed", "uncertain", "expired"].includes(row.state)
        )
          return yield* new WhatsAppRejected({
            message: "This reply cannot be retried.",
          })
        if (row.state === "uncertain" && !acknowledgeDuplicateRisk)
          return yield* new WhatsAppRejected({
            message:
              "Check WhatsApp and acknowledge that retrying may send a duplicate.",
          })
        const [attempts] = yield* this.query((orm) =>
          orm
            .select({ total: count() })
            .from(whatsappRetries)
            .where(eq(whatsappRetries.messageId, id))
        )
        if (attempts!.total >= 100)
          return yield* new WhatsAppRejected({
            message: "This reply reached its retry limit. Open Pi.",
          })
        if ((yield* Clock.currentTimeMillis) >= discoveryDeadline)
          return yield* new WhatsAppUnavailable()
        yield* this.query((orm) =>
          orm
            .insert(whatsappRetries)
            .values({ operationId, messageId: id, acknowledgeDuplicateRisk })
        )
        yield* this.change(
          id,
          {
            type: "RETRY",
            deadline: discoveryDeadline,
            waiting: !!(row.control || row.reply || row.delivery),
            acknowledgeDuplicateRisk,
          },
          { mediaAttempts: 0 }
        )
      })
    )
  }
}
