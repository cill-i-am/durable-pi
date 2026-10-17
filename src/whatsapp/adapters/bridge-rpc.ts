import type { Agent } from "agents"

// Explicit RPC surface breaks the stack/actor environment type cycle.
export interface WhatsAppBridgeRpc extends Agent {
  downloadMedia(
    raw: unknown
  ): Promise<
    { ok: true; bytes: Uint8Array } | { ok: false; retryable: boolean }
  >
  webhook(raw: unknown): Promise<{ status: number; body: string }>
  send(
    threadId: string,
    text: string,
    image?: unknown
  ): Promise<{ ok: true; id: string } | { ok: false; uncertain: boolean }>
}
