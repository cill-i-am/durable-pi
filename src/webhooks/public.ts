import { Schema } from "effect"
import type { WebsiteEnv } from "../../alchemy.run"
import { AgentId } from "../agents/domain"
import { RoutineId } from "../routines/contracts"
import { bearer, EventId, MAX_EVENT_BYTES } from "./contracts"
import { boundedBytes } from "../workspace/http"

/** This public route forwards only webhook authority, never browser cookies or caller owner IDs. */
export async function receiveWebhook(
  request: Request,
  agent: string,
  routine: string,
  env: Pick<WebsiteEnv, "DB" | "OWNER_EMAIL" | "AGENT_SERVICE">
) {
  const response = async () => {
    if (!Schema.is(AgentId)(agent) || !Schema.is(RoutineId)(routine))
      return new Response("Not found", { status: 404 })
    const key = bearer(request)
    if (!key) return new Response("Unauthorized", { status: 401 })
    if (!Schema.is(EventId)(request.headers.get("x-event-id")))
      return Response.json(
        {
          error:
            "Send a unique X-Event-Id of 1–100 letters, numbers, dots, colons, hyphens or underscores.",
        },
        { status: 400 }
      )
    if (
      request.headers.get("content-type")?.split(";")[0]?.trim() !==
      "application/json"
    )
      return Response.json({ error: "Send application/json." }, { status: 415 })
    let bytes: Uint8Array
    try {
      bytes = await boundedBytes(request, MAX_EVENT_BYTES)
    } catch {
      return Response.json({ error: "Send JSON up to 16 KB." }, { status: 413 })
    }
    const owner = await env.DB.prepare(
      "SELECT id FROM user WHERE lower(email)=lower(?) LIMIT 1"
    )
      .bind(env.OWNER_EMAIL)
      .first<{ id: string }>()
    if (!owner) return new Response("Unauthorized", { status: 401 })
    return env.AGENT_SERVICE.fetch(
      new Request(
        `https://agent.internal/api/agent/webhooks/incoming?agent=${encodeURIComponent(agent)}&routine=${encodeURIComponent(routine)}`,
        {
          method: "POST",
          redirect: "manual",
          signal: request.signal,
          headers: {
            "x-owner-id": owner.id,
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
            "x-event-id": request.headers.get("x-event-id")!,
          },
          body: new Uint8Array(bytes).buffer,
        }
      )
    )
  }
  let result: Response
  try {
    result = await response()
  } catch {
    result = Response.json(
      { error: "Webhook temporarily unavailable. Retry the same event ID." },
      { status: 503 }
    )
  }
  const out = new Response(result.body, result)
  out.headers.set("cache-control", "no-store")
  out.headers.set("x-content-type-options", "nosniff")
  return out
}
