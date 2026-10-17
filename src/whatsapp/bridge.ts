import { Agent } from "agents"
import { createChatSdkState } from "agents/chat-sdk"
import { Schema } from "effect"

import type { AgentEnv } from "../../alchemy.run"
import { whatsappChat, whatsappConfigured } from "./adapters/chat"
import { whatsappRpc } from "./adapters/rpc"
import {
  WhatsAppWebhook,
  WhatsAppMedia,
  WhatsAppMediaExport,
} from "./contracts"

export { ChatSdkStateAgent } from "agents/chat-sdk"

/** Transport and SDK state only. PersonalAgent owns admission and reply receipts. */
export class WhatsAppBridge extends Agent<AgentEnv> {
  private chat() {
    return whatsappChat(
      this.env,
      createChatSdkState({ parent: this, name: "whatsapp" }),
      (input) =>
        whatsappRpc(this.env.AGENT.getByName(this.name)).receive(
          this.name,
          input
        )
    )
  }
  async webhook(raw: unknown) {
    if (!whatsappConfigured(this.env))
      return { status: 503, body: "WhatsApp is not configured." }
    return this.chat().webhook(Schema.decodeUnknownSync(WhatsAppWebhook)(raw))
  }
  async downloadMedia(raw: unknown) {
    if (!whatsappConfigured(this.env))
      return { ok: false as const, retryable: true }
    return this.chat().downloadMedia(
      Schema.decodeUnknownSync(WhatsAppMedia)(raw)
    )
  }
  async send(threadId: string, text: string, raw?: unknown) {
    if (!whatsappConfigured(this.env))
      return { ok: false as const, uncertain: false }
    return this.chat().send(
      threadId,
      text,
      raw ? Schema.decodeUnknownSync(WhatsAppMediaExport)(raw) : undefined
    )
  }
}
