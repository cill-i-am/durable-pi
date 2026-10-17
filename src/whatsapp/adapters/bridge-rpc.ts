import type { Agent } from "agents"

// Explicit RPC surface breaks the stack/actor environment type cycle.
export interface WhatsAppBridgeRpc extends Agent {
  webhook(raw: unknown): Promise<{ status: number; body: string }>
  send(
    threadId: string,
    text: string
  ): Promise<{ ok: true; id: string } | { ok: false; uncertain: boolean }>
}
