import { and, asc, count, desc, eq, inArray } from "drizzle-orm"
import { Effect, Schema } from "effect"

import { homeAgentId, type AgentId } from "../../agents/domain"
import { replyComplete, type ReplyProgress } from "../../replies/contracts"
import {
  mapSqliteError,
  type Sqlite,
  type EffectSqliteDatabase,
} from "../../storage/sqlite"
import {
  WhatsAppSettings,
  WhatsAppRecord,
  WhatsAppRejected,
  WhatsAppStorageError,
  WHATSAPP_MAX_PENDING,
  WHATSAPP_MAX_RECORDS,
  WHATSAPP_WINDOW_MS,
  type ConfigureWhatsApp,
  type IncomingWhatsApp,
  type WhatsAppDelivery,
  type WhatsAppFailure,
} from "../contracts"
import { whatsappSettings, whatsappMessages, whatsappRetries } from "./schema"

const pending = ["queued", "waiting", "sending"] as const
export class WhatsAppStore {
  constructor(readonly db: Sqlite) {}
  private query<A, E, R>(
    body: (orm: EffectSqliteDatabase) => Effect.Effect<A, E, R>
  ) {
    return mapSqliteError(
      this.db.use(body),
      () => new WhatsAppStorageError({ operation: "query" })
    )
  }
  private atomic<A, E, R>(body: () => Effect.Effect<A, E, R>) {
    return mapSqliteError(
      this.db.transaction(body),
      () => new WhatsAppStorageError({ operation: "transaction" })
    )
  }
  settings() {
    return this.query((orm) => orm.select().from(whatsappSettings).get()).pipe(
      Effect.map((row) =>
        row
          ? Schema.decodeUnknownSync(WhatsAppSettings)(row)
          : {
              enabled: false,
              agentId: homeAgentId,
              revision: 0,
              generation: 0,
              operationId: "",
              lastInboundAt: 0,
            }
      )
    )
  }
  configure(input: ConfigureWhatsApp, agentId: AgentId) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const current = yield* this.settings()
        if (current.operationId === input.operationId) {
          if (
            current.enabled !== input.enabled ||
            current.agentId !== agentId ||
            current.revision !== input.revision + 1
          )
            return yield* new WhatsAppRejected({
              message: "This request belongs to different WhatsApp settings.",
            })
          return current
        }
        if (current.revision !== input.revision)
          return yield* new WhatsAppRejected({
            message: "WhatsApp settings changed. Reload before saving.",
          })
        const next = {
          ...current,
          enabled: input.enabled,
          agentId,
          revision: current.revision + 1,
          generation:
            current.generation + (input.enabled && !current.enabled ? 1 : 0),
          operationId: input.operationId,
        }
        yield* this.query((orm) =>
          orm
            .insert(whatsappSettings)
            .values({ id: 1, ...next })
            .onConflictDoUpdate({ target: whatsappSettings.id, set: next })
        )
        if (!next.enabled)
          yield* this.query((orm) =>
            orm
              .update(whatsappMessages)
              .set({
                state: "cancelled",
                error: "WhatsApp was disabled. The conversation remains in Pi.",
              })
              .where(inArray(whatsappMessages.state, ["queued", "waiting"]))
          )
        return next
      })
    )
  }
  get(id: string) {
    return this.query((orm) =>
      orm
        .select()
        .from(whatsappMessages)
        .where(eq(whatsappMessages.id, id))
        .get()
    ).pipe(
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
    ).pipe(Effect.map(Schema.decodeUnknownSync(Schema.Array(WhatsAppRecord))))
  }
  pending() {
    return this.query((orm) =>
      orm
        .select()
        .from(whatsappMessages)
        .where(inArray(whatsappMessages.state, pending))
        .orderBy(asc(whatsappMessages.createdAt))
        .limit(WHATSAPP_MAX_PENDING)
    ).pipe(Effect.map(Schema.decodeUnknownSync(Schema.Array(WhatsAppRecord))))
  }
  receive(
    input: IncomingWhatsApp,
    agentId: AgentId,
    {
      reply = "",
      route,
      outboundFileId = null,
    }: { reply?: string; route?: AgentId; outboundFileId?: string | null } = {}
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
        const settings = yield* this.settings()
        if (!settings.enabled) return false
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
        yield* this.query((orm) =>
          orm
            .update(whatsappSettings)
            .set({
              lastInboundAt: Math.max(settings.lastInboundAt, input.timestamp),
              ...(route
                ? {
                    agentId: route,
                    revision: settings.revision + 1,
                    operationId: "",
                  }
                : {}),
            })
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
            state: expired ? "expired" : reply ? "waiting" : "queued",
            reply,
            error: expired
              ? "The WhatsApp reply window closed. Open Pi to review this request."
              : null,
            createdAt: Date.now(),
          })
        )
        return true
      })
    )
  }
  update(
    id: string,
    from: WhatsAppDelivery,
    state: WhatsAppDelivery,
    details: {
      reply?: string
      delivery?: ReplyProgress
      error?: string | null
      providerId?: string | null
      fileId?: string
      mediaAttempts?: number
    } = {}
  ) {
    return this.query((orm) =>
      orm
        .update(whatsappMessages)
        .set({ state, ...details })
        .where(
          and(eq(whatsappMessages.id, id), eq(whatsappMessages.state, from))
        )
        .returning({ id: whatsappMessages.id })
    ).pipe(Effect.map((rows) => rows.length > 0))
  }
  claim(
    record: WhatsAppRecord,
    reply: string,
    active: () => Effect.Effect<boolean, WhatsAppFailure>,
    delivery?: ReplyProgress,
    from: "waiting" | "sending" = "waiting"
  ) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const settings = yield* this.settings()
        if (
          !settings.enabled ||
          settings.generation !== record.generation ||
          !(yield* active())
        ) {
          yield* this.update(record.id, from, "cancelled", {
            error:
              "WhatsApp is disabled or the agent is archived. Review this conversation in Pi.",
          })
          return false
        }
        if (Date.now() - settings.lastInboundAt >= WHATSAPP_WINDOW_MS) {
          yield* this.update(record.id, from, "expired", {
            reply,
            error:
              "The WhatsApp reply window closed. Send a new WhatsApp message before retrying.",
          })
          return false
        }
        return yield* this.update(record.id, from, "sending", {
          reply,
          ...(delivery ? { delivery } : {}),
          error: null,
        })
      })
    )
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

  beginMedia(id: string) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const record = yield* this.get(id)
        if (!record || record.state !== "queued") return false
        if (record.mediaAttempts >= 5) {
          yield* this.update(id, "queued", "failed", {
            error:
              "The image could not be prepared after several attempts. Retry or send it again.",
          })
          return false
        }
        return yield* this.update(id, "queued", "queued", {
          mediaAttempts: record.mediaAttempts + 1,
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
        yield* this.query((orm) =>
          orm
            .insert(whatsappRetries)
            .values({ operationId, messageId: id, acknowledgeDuplicateRisk })
        )
        yield* this.update(
          id,
          row.state,
          row.control || row.reply ? "waiting" : "queued",
          { error: null, mediaAttempts: 0 }
        )
      })
    )
  }
}
