import { createWhatsAppAdapter, WhatsAppApiError } from "@chat-adapter/whatsapp"
import { Chat, ConsoleLogger, type StateAdapter } from "chat"
import { Schema } from "effect"

import {
  IncomingWhatsApp,
  WHATSAPP_WINDOW_MS,
  whatsappIdentity,
  type WhatsAppWebhook,
} from "../contracts"

export interface WhatsAppConfiguration {
  WHATSAPP_ACCESS_TOKEN: string
  WHATSAPP_APP_SECRET: string
  WHATSAPP_PHONE_NUMBER_ID: string
  WHATSAPP_VERIFY_TOKEN: string
  WHATSAPP_OWNER_ID: string
  WHATSAPP_BUSINESS_NUMBER: string
}
export function whatsappConfigured(env: WhatsAppConfiguration) {
  return !!(
    env.WHATSAPP_ACCESS_TOKEN &&
    env.WHATSAPP_APP_SECRET &&
    env.WHATSAPP_VERIFY_TOKEN &&
    /^\d+$/.test(env.WHATSAPP_PHONE_NUMBER_ID) &&
    /^[A-Za-z0-9_.-]{1,128}$/.test(env.WHATSAPP_OWNER_ID)
  )
}
const RawText = Schema.Struct({
  phoneNumberId: Schema.String,
  message: Schema.Struct({
    type: Schema.Literal("text"),
    timestamp: Schema.String,
  }),
})

/** The SDK verifies and normalizes Meta payloads. Pi owns durable admission and
 * dedupe; never acknowledge a failed handler behind the SDK's temporary marker. */
export function whatsappChat(
  env: WhatsAppConfiguration,
  state: StateAdapter,
  receive: (input: typeof IncomingWhatsApp.Type) => Promise<unknown>
) {
  let failed = false
  const logger = new ConsoleLogger("silent")
  // Some adapter parsing failures are reported through its logger instead of
  // being thrown. Retain that signal without recording provider bodies/secrets.
  logger.error = () => {
    failed = true
  }
  const adapter = createWhatsAppAdapter({
    accessToken: env.WHATSAPP_ACCESS_TOKEN,
    appSecret: env.WHATSAPP_APP_SECRET,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    verifyToken: env.WHATSAPP_VERIFY_TOKEN,
    userName: "Pi",
    logger,
  })
  const bot = new Chat({
    userName: "Pi",
    adapters: { whatsapp: adapter },
    state,
    logger,
    concurrency: "concurrent",
    history: { thread: { maxMessages: 20, ttlMs: WHATSAPP_WINDOW_MS } },
  })
  bot.onDirectMessage(async (thread, message) => {
    const raw = Schema.decodeUnknownOption(RawText)(message.raw)
    if (
      message.author.userId !== env.WHATSAPP_OWNER_ID ||
      raw._tag === "None" ||
      raw.value.phoneNumberId !== env.WHATSAPP_PHONE_NUMBER_ID ||
      message.attachments.length ||
      !message.text.trim()
    )
      return
    const identity = await whatsappIdentity(
      `${env.WHATSAPP_PHONE_NUMBER_ID}:${message.id}`
    )
    const body = {
      id: identity.id,
      messageId: message.id,
      threadId: thread.id,
      sender: message.author.userId,
      body: message.text,
      timestamp: Number(raw.value.message.timestamp) * 1000,
    }
    const fingerprint = await whatsappIdentity(JSON.stringify(body))
    await receive(
      Schema.decodeUnknownSync(IncomingWhatsApp)({
        ...body,
        fingerprint: fingerprint.fingerprint,
      })
    )
  })
  return {
    async webhook(input: WhatsAppWebhook) {
      const url = new URL("https://whatsapp.internal/webhook")
      if (input.method === "GET") {
        url.searchParams.set("hub.mode", input.mode)
        url.searchParams.set("hub.verify_token", input.token)
        url.searchParams.set("hub.challenge", input.challenge)
      }
      const pending: Promise<unknown>[] = []
      try {
        const response = await bot.webhooks.whatsapp(
          new Request(url, {
            method: input.method,
            headers: { "x-hub-signature-256": input.signature },
            ...(input.method === "POST" ? { body: input.body } : {}),
          }),
          {
            deduplicate: false,
            propagateHandlerErrors: true,
            waitUntil: (work) => {
              pending.push(work)
            },
          }
        )
        const settled = await Promise.allSettled(pending)
        if (failed || settled.some((result) => result.status === "rejected"))
          return {
            status: 503,
            body: "WhatsApp admission is temporarily unavailable.",
          }
        return { status: response.status, body: await response.text() }
      } catch {
        await Promise.allSettled(pending)
        return {
          status: 503,
          body: "WhatsApp admission is temporarily unavailable.",
        }
      } finally {
        await bot.shutdown()
      }
    },
    async send(threadId: string, text: string) {
      try {
        const target = adapter.decodeThreadId(threadId)
        if (
          target.phoneNumberId !== env.WHATSAPP_PHONE_NUMBER_ID ||
          target.userWaId !== env.WHATSAPP_OWNER_ID ||
          text.length > 3900
        )
          return { ok: false as const, uncertain: false }
        await bot.initialize()
        // Plain text avoids markdown expansion and automatic multi-message sends.
        const result = await adapter.postMessage(threadId, text)
        return { ok: true as const, id: result.id }
      } catch (error) {
        return {
          ok: false as const,
          uncertain: !(
            error instanceof WhatsAppApiError &&
            [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(
              error.status ?? 0
            )
          ),
        }
      } finally {
        await bot.shutdown()
      }
    },
  }
}
