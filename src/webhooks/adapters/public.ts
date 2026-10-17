import { Cause, Effect, Exit, Schema } from "effect"

import { AgentId } from "../../agents/domain"
import type { AuthStorageError } from "../../auth/adapters/accounts"
import { RoutineId } from "../../routines/contracts"
import { preserveFatal } from "../../shared/effect"
import { requestBytes } from "../../shared/http"
import { nativeOperation, releaseUnreadResponse } from "../../shared/interop"
import { EventId, MAX_EVENT_BYTES } from "../contracts"
import { bearer } from "./crypto"

class WebhookBodyInvalid extends Schema.TaggedError<WebhookBodyInvalid>()(
  "WebhookBodyInvalid",
  {}
) {}
class WebhookIngressUnavailable extends Schema.TaggedError<WebhookIngressUnavailable>()(
  "WebhookIngressUnavailable",
  {}
) {}
const native = <T>(start: (signal: AbortSignal) => Promise<T>) =>
  nativeOperation(start, (cause, channel) => {
    if (channel === "failure" || Schema.isSchemaError(cause)) throw cause
    return new WebhookIngressUnavailable()
  })

/** Only the native operations used by public ingress, without unrelated bindings. */
export interface WebhookIngressBindings {
  owner: () => Effect.Effect<unknown, AuthStorageError>
  AGENT_SERVICE: { fetch: (request: Request) => Promise<Response> }
}
export async function receiveWebhook(
  request: Request,
  agent: string,
  routine: string,
  env: WebhookIngressBindings
) {
  let acquired: Response | undefined
  const program = Effect.gen(function* () {
    yield* Effect.yieldNow
    yield* Effect.addFinalizer(() =>
      acquired ? releaseUnreadResponse(acquired) : Effect.void
    )
    if (!Schema.is(AgentId)(agent) || !Schema.is(RoutineId)(routine))
      return new Response("Not found", { status: 404 })
    const key = bearer(request)
    if (!key) return new Response("Unauthorized", { status: 401 })
    const eventId = Schema.decodeUnknownOption(EventId)(
      request.headers.get("x-event-id")
    )
    if (eventId._tag === "None")
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
    const bytes = yield* requestBytes(
      request,
      MAX_EVENT_BYTES,
      () => new WebhookBodyInvalid()
    )
    const owner = yield* env
      .owner()
      .pipe(
        Effect.catchCause((cause) =>
          Effect.failCause(
            Cause.map(cause, () => new WebhookIngressUnavailable())
          )
        )
      )
    const ownerId = yield* Schema.decodeUnknownEffect(
      Schema.NullOr(Schema.String)
    )(owner).pipe(Effect.orDie)
    if (!ownerId) return new Response("Unauthorized", { status: 401 })
    return yield* native((signal) =>
      env.AGENT_SERVICE.fetch(
        new Request(
          `https://agent.internal/api/agent/webhooks/incoming?agent=${encodeURIComponent(agent)}&routine=${encodeURIComponent(routine)}`,
          {
            method: "POST",
            redirect: "manual",
            signal,
            headers: {
              "x-owner-id": ownerId,
              "content-type": "application/json",
              authorization: `Bearer ${key}`,
              "x-event-id": eventId.value,
            },
            body: new Uint8Array(bytes).buffer,
          }
        )
      ).then((response) => {
        acquired = response
        return response
      })
    )
  }).pipe(
    preserveFatal,
    Effect.catchTags({
      WebhookBodyInvalid: () =>
        Effect.succeed(
          Response.json({ error: "Send JSON up to 16 KB." }, { status: 413 })
        ),
      WebhookIngressUnavailable: () =>
        Effect.succeed(
          Response.json(
            {
              error:
                "Webhook temporarily unavailable. Retry the same event ID.",
            },
            { status: 503 }
          )
        ),
    }),
    Effect.map((result) => {
      const out = new Response(result.body, result)
      out.headers.set("cache-control", "no-store")
      out.headers.set("x-content-type-options", "nosniff")
      // The returned native body becomes responsible for subsequent reads/cancel.
      acquired = undefined
      return out
    }),
    Effect.scoped
  )
  const exit = await Effect.runPromiseExit(program, { signal: request.signal })
  if (Exit.isFailure(exit)) throw exit.cause
  return exit.value
}
