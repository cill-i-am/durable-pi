import { Agent } from "agents"

import { audioBytes } from "../audio-fixture"

/** Synthetic provider boundary; the actor, Pi queue, receipts and RPC are real. */
export class WhatsAppSink extends Agent {
  async downloadMedia(media: { mime: string }) {
    return {
      ok: true as const,
      bytes: media.mime.startsWith("audio/")
        ? audioBytes
        : new Uint8Array([255, 216, 255, 224, 0, 16]),
    }
  }
  async send(_threadId: string, body: string, image?: unknown) {
    this
      .sql`CREATE TABLE IF NOT EXISTS fixture_whatsapp_sends (body TEXT NOT NULL,image TEXT)`
    this
      .sql`INSERT INTO fixture_whatsapp_sends VALUES (${body},${image ? JSON.stringify(image) : null})`
    return { ok: true as const, id: "wamid.native-provider" }
  }
  async inspect() {
    this
      .sql`CREATE TABLE IF NOT EXISTS fixture_whatsapp_sends (body TEXT NOT NULL,image TEXT)`
    return this.sql<{
      body: string
      image: string | null
    }>`SELECT body,image FROM fixture_whatsapp_sends`
  }
}
