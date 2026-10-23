import { Effect } from "effect"

import type { AgentId } from "../../agents/domain"
import { jsonRequest } from "../../shared/http"
import {
  ConfigureWhatsApp,
  RetryWhatsApp,
  WhatsAppRejected,
  type WhatsAppFailure,
} from "../contracts"
import { whatsappResponse, type whatsappApplication } from "../service"

export function whatsappRequest(
  request: Request,
  path: string,
  id: AgentId,
  app: ReturnType<typeof whatsappApplication>,
  wake: () => Effect.Effect<unknown, WhatsAppFailure>
) {
  return whatsappResponse(
    Effect.gen(function* () {
      if (request.method === "POST" && path === "whatsapp/configure") {
        const input = yield* jsonRequest(
          request,
          ConfigureWhatsApp,
          2048,
          () => new WhatsAppRejected({ message: "Invalid WhatsApp settings." })
        )
        yield* app.configure(input, id)
        yield* wake()
      } else if (request.method === "POST" && path === "whatsapp/retry") {
        const input = yield* jsonRequest(
          request,
          RetryWhatsApp,
          2048,
          () => new WhatsAppRejected({ message: "Invalid WhatsApp retry." })
        )
        yield* app.retry(input)
      } else if (request.method !== "GET" || path !== "whatsapp")
        return new Response("Not found", { status: 404 })
      return Response.json(yield* app.view(), {
        headers: { "Cache-Control": "no-store" },
      })
    })
  )
}
