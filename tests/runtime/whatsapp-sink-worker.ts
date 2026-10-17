import { Agent } from "agents"

/** Synthetic provider boundary; the actor, Pi queue, receipts and RPC are real. */
export class WhatsAppSink extends Agent {
  async send(_threadId: string, body: string) {
    this
      .sql`CREATE TABLE IF NOT EXISTS fixture_whatsapp_sends (body TEXT NOT NULL)`
    this.sql`INSERT INTO fixture_whatsapp_sends VALUES (${body})`
    return { ok: true as const, id: "wamid.native-provider" }
  }
  async inspect() {
    this
      .sql`CREATE TABLE IF NOT EXISTS fixture_whatsapp_sends (body TEXT NOT NULL)`
    return this.sql<{ body: string }>`SELECT body FROM fixture_whatsapp_sends`
  }
}
