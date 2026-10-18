import { createHash, createHmac } from "node:crypto"

import { createMemoryState } from "@chat-adapter/state-memory"
import { WhatsAppAdapter } from "@chat-adapter/whatsapp"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  whatsappChat,
  type WhatsAppConfiguration,
} from "../src/whatsapp/adapters/chat"
import type {
  IncomingWhatsApp,
  WhatsAppWebhook,
} from "../src/whatsapp/contracts"
import { audioBytes, audioMetadata } from "./audio-fixture"
import { imageBytes, imageMetadata } from "./image-fixture"

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
  phone = env.WHATSAPP_PHONE_NUMBER_ID,
  caption = "Please inspect this image."
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
                        [type === "audio" ? "audio" : "image"]: {
                          id:
                            type === "audio"
                              ? audioMetadata.id
                              : imageMetadata.id,
                          mime_type:
                            type === "audio"
                              ? "audio/ogg; codecs=opus"
                              : imageMetadata.mime,
                          sha256:
                            type === "audio"
                              ? audioMetadata.sha256
                              : imageMetadata.sha256,
                          ...(type === "audio" ? { voice: true } : { caption }),
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
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
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
    ["15550999999", "image", env.WHATSAPP_PHONE_NUMBER_ID],
    ["15550999999", "audio", env.WHATSAPP_PHONE_NUMBER_ID],
    [env.WHATSAPP_OWNER_ID, "video", env.WHATSAPP_PHONE_NUMBER_ID],
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
  it.each(["Please inspect this image.", ""])(
    "admits signed image metadata and caption without downloading during webhook handling",
    async (caption) => {
      const receive = vi.fn(async (_input: IncomingWhatsApp) => {})
      const download = vi.spyOn(WhatsAppAdapter.prototype, "downloadMedia")
      expect(
        (
          await whatsappChat(env, createMemoryState(), receive).webhook(
            event(
              env.WHATSAPP_OWNER_ID,
              "image",
              env.WHATSAPP_PHONE_NUMBER_ID,
              caption
            )
          )
        ).status
      ).toBe(200)
      expect(receive).toHaveBeenCalledWith(
        expect.objectContaining({
          media: imageMetadata,
          body: caption || "Please inspect the attached image.",
        })
      )
      const input = receive.mock.calls[0]![0]
      const releasedFingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            id: input.id,
            messageId: input.messageId,
            threadId: input.threadId,
            sender: input.sender,
            body: input.body,
            timestamp: input.timestamp,
            image: imageMetadata,
          })
        )
        .digest("hex")
      expect(input.fingerprint).toBe(releasedFingerprint)
      expect(download).not.toHaveBeenCalled()
    }
  )
  it("admits a signed voice note without downloading during webhook handling", async () => {
    const receive = vi.fn(async (_input: IncomingWhatsApp) => {})
    const download = vi.spyOn(WhatsAppAdapter.prototype, "downloadMedia")
    expect(
      (
        await whatsappChat(env, createMemoryState(), receive).webhook(
          event(env.WHATSAPP_OWNER_ID, "audio")
        )
      ).status
    ).toBe(200)
    expect(receive).toHaveBeenCalledWith(
      expect.objectContaining({
        media: audioMetadata,
        body: "Please respond to my voice message.",
      })
    )
    expect(download).not.toHaveBeenCalled()
  })
  it("validates an audio download against the container and signed digest", async () => {
    const download = vi
      .spyOn(WhatsAppAdapter.prototype, "downloadMedia")
      .mockResolvedValue(Buffer.from(audioBytes))
    const chat = () => whatsappChat(env, createMemoryState(), async () => {})
    expect(await chat().downloadMedia(audioMetadata)).toEqual({
      ok: true,
      bytes: audioBytes,
    })
    expect(
      await chat().downloadMedia({ ...audioMetadata, sha256: "a".repeat(64) })
    ).toEqual({ ok: false, retryable: false })
    download.mockResolvedValueOnce(Buffer.from(imageBytes))
    expect(await chat().downloadMedia(audioMetadata)).toEqual({
      ok: false,
      retryable: false,
    })
  })
  it("validates downloaded image type and digest before exposing its bytes", async () => {
    const download = vi
      .spyOn(WhatsAppAdapter.prototype, "downloadMedia")
      .mockResolvedValue(Buffer.from(imageBytes))
    const chat = () => whatsappChat(env, createMemoryState(), async () => {})
    expect(await chat().downloadMedia(imageMetadata)).toEqual({
      ok: true,
      bytes: imageBytes,
    })
    expect(
      await chat().downloadMedia({ ...imageMetadata, sha256: "a".repeat(64) })
    ).toEqual({ ok: false, retryable: false })
    download.mockResolvedValueOnce(Buffer.from("not an image"))
    expect(await chat().downloadMedia(imageMetadata)).toEqual({
      ok: false,
      retryable: false,
    })
  })
  it("uploads a private image and sends one captioned media message", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith("/media")
        ? Response.json({ id: "123999" })
        : Response.json({ messages: [{ id: "wamid.photo-reply" }] })
    )
    vi.stubGlobal("fetch", fetch)
    const thread = `whatsapp:${env.WHATSAPP_PHONE_NUMBER_ID}:${env.WHATSAPP_OWNER_ID}`
    expect(
      await whatsappChat(env, createMemoryState(), async () => {}).send(
        thread,
        "Here is your image.",
        {
          name: "photo.jpg",
          mime: "image/jpeg",
          data: Buffer.from(imageBytes).toString("base64"),
        }
      )
    ).toEqual({ ok: true, id: "wamid.photo-reply" })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[0]?.[0]).toContain("/media")
    const posts = fetch.mock.calls.filter((call) =>
      String(call[0]).endsWith("/messages")
    )
    expect(posts).toHaveLength(1)
  })
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
  it.each([
    ["report.pdf", "application/pdf", "document"],
    ["report.txt", "text/plain", "document"],
    ["voice.ogg", "audio/ogg", "audio"],
    ["clip.mp4", "video/mp4", "video"],
  ])(
    "sends %s as one provider message with original bytes and no hidden caption send",
    async (name, mime, kind) => {
      const bytes = new Uint8Array([0, 1, 127, 128, 255])
      const messages: Record<string, unknown>[] = []
      const uploads: { name: string; type: string; bytes: Uint8Array }[] = []
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          if (String(input).endsWith("/media")) {
            const form = init!.body as FormData
            const file = form.get("file") as File
            uploads.push({
              name: file.name,
              type: file.type,
              bytes: new Uint8Array(await file.arrayBuffer()),
            })
            return Response.json({ id: "media.synthetic" })
          }
          messages.push(JSON.parse(String(init!.body)))
          return Response.json({ messages: [{ id: "wamid.file" }] })
        })
      )
      const result = await whatsappChat(
        env,
        createMemoryState(),
        async () => {}
      ).send(
        `whatsapp:${env.WHATSAPP_PHONE_NUMBER_ID}:${env.WHATSAPP_OWNER_ID}`,
        "",
        { name, mime, data: btoa(String.fromCharCode(...bytes)) }
      )
      expect(result).toEqual({ ok: true, id: "wamid.file" })
      expect(uploads).toEqual([{ name, type: mime, bytes }])
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        type: kind,
        [kind]: { id: "media.synthetic" },
      })
      expect(messages[0]![kind]).not.toHaveProperty("caption")
    }
  )
})
