import { Effect, Schema } from "effect"

import type { WhatsAppEnv } from "../../alchemy.run"
import { ownerAccounts } from "../auth/adapters/accounts"
import { requestBytes } from "../shared/http"
import { WhatsAppWebhook } from "./contracts"

// The public verification URL contains a token. No invocation/body logging here.
export default {
  async fetch(request: Request, env: WhatsAppEnv) {
    const url = new URL(request.url)
    if (
      url.pathname !== "/webhook" ||
      !["GET", "POST"].includes(request.method)
    )
      return new Response("Not found", { status: 404 })
    const body =
      request.method === "POST"
        ? await Effect.runPromiseExit(
            requestBytes(request, 256 * 1024, () => "Invalid webhook")
          )
        : undefined
    if (body && body._tag === "Failure")
      return new Response("Webhook is too large or unreadable.", {
        status: 413,
      })
    const decoded = Schema.decodeUnknownOption(WhatsAppWebhook)({
      method: request.method,
      body: body ? new TextDecoder().decode(body.value) : "",
      signature: request.headers.get("x-hub-signature-256") ?? "",
      mode: url.searchParams.get("hub.mode") ?? "",
      token: url.searchParams.get("hub.verify_token") ?? "",
      challenge: url.searchParams.get("hub.challenge") ?? "",
    })
    if (decoded._tag === "None")
      return new Response("Invalid webhook.", { status: 400 })
    try {
      const owner = await Effect.runPromise(
        ownerAccounts(env.AUTH_DB).owner(env.OWNER_EMAIL)
      )
      if (!owner)
        return new Response("Set up the Pi owner first.", { status: 503 })
      // Reconstruct the verification request only inside the SDK, never as an
      // invocation URL on a Worker whose access logging is enabled.
      return await env.AGENT_SERVICE.fetch(
        new Request("https://agent.internal/api/whatsapp/webhook", {
          method: "POST",
          headers: { "x-owner-id": owner, "content-type": "application/json" },
          body: JSON.stringify(decoded.value),
        })
      )
    } catch {
      return new Response("WhatsApp is temporarily unavailable.", {
        status: 503,
      })
    }
  },
} satisfies ExportedHandler<WhatsAppEnv>
