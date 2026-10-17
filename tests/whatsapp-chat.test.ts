import { createHmac } from "node:crypto"

import { createMemoryState } from "@chat-adapter/state-memory"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  whatsappChat,
  type WhatsAppConfiguration,
} from "../src/whatsapp/adapters/chat"
import type {
  IncomingWhatsApp,
  WhatsAppWebhook,
} from "../src/whatsapp/contracts"

const env: WhatsAppConfiguration = {
  WHATSAPP_ACCESS_TOKEN: "synthetic-whatsapp-token",
  WHATSAPP_APP_SECRET: "synthetic-whatsapp-secret",
  WHATSAPP_PHONE_NUMBER_ID: "123456",
  WHATSAPP_VERIFY_TOKEN: "synthetic-verification-token",
  WHATSAPP_OWNER_ID: "15550101010",
  WHATSAPP_BUSINESS_NUMBER: "15550102020",
}
function event(
  sender = env.WHATSAPP_OWNER_ID,
  type = "text",
  phone = env.WHATSAPP_PHONE_NUMBER_ID
): WhatsAppWebhook {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "account",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                phone_number_id: phone,
                display_phone_number: "15550102020",
              },
              contacts: [
                { profile: { name: "Synthetic owner" }, wa_id: sender },
              ],
              messages: [
                {
                  id: "wamid.synthetic",
                  from: sender,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type,
                  ...(type === "text"
                    ? { text: { body: "Help with dinner." } }
                    : {
                        image: {
                          id: "synthetic-media",
                          mime_type: "image/png",
                          caption: "Caption is not a text request.",
                        },
                      }),
                },
              ],
            },
          },
        ],
      },
    ],
  })
  return {
    method: "POST",
    body,
    signature: `sha256=${createHmac("sha256", env.WHATSAPP_APP_SECRET).update(body).digest("hex")}`,
    mode: "",
    token: "",
    challenge: "",
  }
}
afterEach(() => vi.unstubAllGlobals())
describe("official WhatsApp Chat SDK transport", () => {
  it("verifies the Meta challenge and signature before delivering normalized text", async () => {
    const receive = vi.fn(async (_input: IncomingWhatsApp) => {})
    const chat = whatsappChat(env, createMemoryState(), receive)
    const input = event()
    expect(
      await chat.webhook({
        ...input,
        method: "GET",
        mode: "subscribe",
        token: env.WHATSAPP_VERIFY_TOKEN,
        challenge: "synthetic-challenge",
      })
    ).toEqual({ status: 200, body: "synthetic-challenge" })
    expect(
      (
        await whatsappChat(env, createMemoryState(), receive).webhook({
          ...input,
          signature: "sha256=invalid",
        })
      ).status
    ).toBe(401)
    expect(receive).not.toHaveBeenCalled()
    expect(
      (await whatsappChat(env, createMemoryState(), receive).webhook(input))
        .status
    ).toBe(200)
    expect(receive).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "Help with dinner.",
        sender: env.WHATSAPP_OWNER_ID,
        threadId: `whatsapp:${env.WHATSAPP_PHONE_NUMBER_ID}:${env.WHATSAPP_OWNER_ID}`,
        messageId: "wamid.synthetic",
      })
    )
  })
  it.each([
    ["15550999999", "text", env.WHATSAPP_PHONE_NUMBER_ID],
    [env.WHATSAPP_OWNER_ID, "image", env.WHATSAPP_PHONE_NUMBER_ID],
    [env.WHATSAPP_OWNER_ID, "text", "999999"],
  ])(
    "never admits an unknown sender, media caption or foreign business number",
    async (sender, type, phone) => {
      const receive = vi.fn(async () => {})
      const network = vi.fn(() =>
        Promise.reject(new Error("No media downloads are permitted"))
      )
      vi.stubGlobal("fetch", network)
      expect(
        (
          await whatsappChat(env, createMemoryState(), receive).webhook(
            event(sender, type, phone)
          )
        ).status
      ).toBe(200)
      expect(receive).not.toHaveBeenCalled()
      expect(network).not.toHaveBeenCalled()
    }
  )
  it("propagates admission failure and processes the same provider ID on retry", async () => {
    const state = createMemoryState(),
      receive = vi.fn<(input: IncomingWhatsApp) => Promise<void>>()
    receive
      .mockRejectedValueOnce(new Error("Synthetic admission unavailable"))
      .mockResolvedValue(undefined)
    const input = event()
    expect(
      (await whatsappChat(env, state, receive).webhook(input)).status
    ).toBe(503)
    expect(
      (await whatsappChat(env, state, receive).webhook(input)).status
    ).toBe(200)
    expect(receive).toHaveBeenCalledTimes(2)
    expect(receive.mock.calls[0]![0].id).toBe(receive.mock.calls[1]![0].id)
  })
  it("performs a single text send and distinguishes provider rejection from uncertain transport", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ messages: [{ id: "wamid.sent" }] })
    )
    vi.stubGlobal("fetch", fetch)
    const thread = `whatsapp:${env.WHATSAPP_PHONE_NUMBER_ID}:${env.WHATSAPP_OWNER_ID}`
    expect(
      await whatsappChat(env, createMemoryState(), async () => {}).send(
        thread,
        "A short reply."
      )
    ).toEqual({ ok: true, id: "wamid.sent" })
    expect(fetch).toHaveBeenCalledTimes(1)
    fetch.mockResolvedValueOnce(
      Response.json(
        { error: { code: 131047, message: "Synthetic closed window" } },
        { status: 400 }
      )
    )
    expect(
      await whatsappChat(env, createMemoryState(), async () => {}).send(
        thread,
        "A short reply."
      )
    ).toEqual({ ok: false, uncertain: false })
    fetch.mockRejectedValueOnce(new Error("Synthetic disconnected transport"))
    expect(
      await whatsappChat(env, createMemoryState(), async () => {}).send(
        thread,
        "A short reply."
      )
    ).toEqual({ ok: false, uncertain: true })
    expect(
      await whatsappChat(env, createMemoryState(), async () => {}).send(
        "whatsapp:123456:15550999999",
        "Private reply"
      )
    ).toEqual({ ok: false, uncertain: false })
    expect(fetch).toHaveBeenCalledTimes(3)
    fetch.mockResolvedValueOnce(
      Response.json(
        { error: { message: "Synthetic upstream failure" } },
        { status: 503 }
      )
    )
    expect(
      await whatsappChat(env, createMemoryState(), async () => {}).send(
        thread,
        "A short reply."
      )
    ).toEqual({ ok: false, uncertain: true })
  })
})
