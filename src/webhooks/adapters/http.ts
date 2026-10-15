import { preserveFatal } from "../../shared/effect"
import { nativeOperation } from "../../shared/interop"
import { jsonRequest, requestBytes } from "../../shared/http"
import { Effect, Schema } from "effect"
import { RoutineId } from "../../routines/contracts"
import type { Webhooks } from "../service"
import type { WebhookRejected } from "../contracts"
import { ConfigureWebhook, EventId, MAX_EVENT_BYTES } from "../contracts"
import { bearer, digest } from "./crypto"

class WebhookHttpError extends Schema.TaggedError<WebhookHttpError>()(
  "WebhookHttpError",
  { status: Schema.Number, message: Schema.String }
) {}
const invalid = () =>
  new WebhookHttpError({ status: 400, message: "Invalid webhook request." })
const invalidEvent = () =>
  new WebhookHttpError({ status: 400, message: "Send valid JSON up to 16 KB." })
const statusFor = (reason: WebhookRejected["reason"]) =>
  ({ unauthorized: 401, conflict: 409, busy: 429 })[reason]
const unavailable = () =>
  new WebhookHttpError({
    status: 503,
    message: "Webhook temporarily unavailable. Retry the same request.",
  })
const decode = <T>(
  schema: Schema.Codec<T, unknown>,
  value: unknown,
  rejected = invalid
) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    preserveFatal,
    Effect.mapError(rejected)
  )

/** Native wake/crypto acknowledgments may arrive after caller cancellation. */
export const webhookNative = <T>(start: () => Promise<T>) =>
  nativeOperation(start, (cause, channel) => {
    if (channel === "failure" || Schema.isSchemaError(cause)) throw cause
    return new WebhookHttpError({
      status: 503,
      message: "Webhook temporarily unavailable. Retry the same event ID.",
    })
  })
const respond = (error: WebhookHttpError) =>
  Effect.succeed(
    Response.json(
      { error: error.message },
      {
        status: error.status,
        headers: error.status === 429 ? { "retry-after": "60" } : undefined,
      }
    )
  )

export function webhookOwnerRequest(
  store: Webhooks["Service"],
  request: Request,
  path: string
) {
  return Effect.gen(function* () {
    if (request.method === "GET" && path === "webhooks") {
      const id = yield* decode(
        RoutineId,
        new URL(request.url).searchParams.get("routine")
      )
      return Response.json(yield* store.info(id))
    }
    if (request.method !== "POST")
      return new Response("Not found", { status: 404 })
    const raw = yield* jsonRequest(request, Schema.Unknown, 2048, invalidEvent)
    if (path === "webhooks/cancel") {
      const { operationId } = yield* decode(
        Schema.Struct({ operationId: RoutineId }),
        raw
      )
      return Response.json(yield* store.cancel(operationId))
    }
    if (path !== "webhooks/configure")
      return new Response("Not found", { status: 404 })
    const { key, ...input } = yield* decode(ConfigureWebhook, raw)
    const hash = key ? yield* webhookNative(() => digest(key)) : null
    return Response.json(yield* store.configure({ ...input, hash }))
  }).pipe(
    preserveFatal,
    Effect.catchTag("WebhookRejected", (error) =>
      respond(
        new WebhookHttpError({
          status: statusFor(error.reason),
          message: error.message,
        })
      )
    ),
    preserveFatal,
    Effect.catchTags({
      WebhookStorageError: () => respond(unavailable()),
      RoutineStorageError: () => respond(unavailable()),
      WebhookHttpError: respond,
    })
  )
}

export function webhookIncoming<TRequirements>(
  store: Webhooks["Service"],
  request: Request,
  wake: () => Effect.Effect<void, WebhookHttpError, TRequirements>
) {
  return Effect.gen(function* () {
    const id = yield* decode(
      RoutineId,
      new URL(request.url).searchParams.get("routine")
    )
    const key = bearer(request)
    if (!key)
      return yield* new WebhookHttpError({
        status: 401,
        message: "Invalid webhook authorization.",
      })
    const keyHash = yield* webhookNative(() => digest(key))
    if (!(yield* store.authorized(id, keyHash)))
      return yield* new WebhookHttpError({
        status: 401,
        message: "Invalid webhook authorization.",
      })
    const eventId = yield* decode(EventId, request.headers.get("x-event-id"))
    if (
      request.headers.get("content-type")?.split(";")[0]?.trim() !==
      "application/json"
    )
      return yield* new WebhookHttpError({
        status: 415,
        message: "Send application/json.",
      })
    const bytes = yield* requestBytes(request, MAX_EVENT_BYTES, invalidEvent)
    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: invalidEvent,
    })
    const value = yield* decode(
      Schema.fromJsonString(Schema.Unknown),
      text,
      invalidEvent
    )
    if (!value || typeof value !== "object" || Array.isArray(value))
      return yield* new WebhookHttpError({
        status: 400,
        message: "Send a JSON object.",
      })
    const payload = JSON.stringify(value)
    if (new TextEncoder().encode(payload).length > MAX_EVENT_BYTES)
      return yield* new WebhookHttpError({
        status: 413,
        message: "The normalized JSON event exceeds 16 KB.",
      })
    const hash = yield* webhookNative(() => digest(payload))
    yield* wake()
    const result = yield* store.accept(id, keyHash, eventId, payload, hash)
    yield* wake()
    return Response.json(result, { status: result.duplicate ? 200 : 202 })
  }).pipe(
    preserveFatal,
    Effect.catchTag("WebhookRejected", (error) =>
      respond(
        new WebhookHttpError({
          status: statusFor(error.reason),
          message: error.message,
        })
      )
    ),
    preserveFatal,
    Effect.catchTags({
      WebhookStorageError: () => respond(unavailable()),
      RoutineStorageError: () => respond(unavailable()),
      WebhookHttpError: respond,
    })
  )
}
