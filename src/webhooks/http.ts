import { Effect, Schema } from "effect"
import { boundedBytes } from "../workspace/http"
import { RoutineId } from "../routines/contracts"
import type { WebhookStore } from "./adapters/sqlite"
import {
  ConfigureWebhook,
  EventId,
  MAX_EVENT_BYTES,
  WebhookRejected,
  bearer,
  digest,
  reject,
} from "./contracts"

const guard = <T>(run: () => T, status = 400) =>
  Effect.try({
    try: run,
    catch: (cause) =>
      cause instanceof WebhookRejected
        ? cause
        : new WebhookRejected({
            status,
            message:
              status === 503
                ? "Webhook temporarily unavailable. Retry the same request."
                : "Invalid webhook request.",
          }),
  })
const asyncGuard = <T>(run: () => Promise<T>, status = 503) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof WebhookRejected
        ? cause
        : new WebhookRejected({
            status,
            message:
              status === 400
                ? "Send valid JSON up to 16 KB."
                : "Webhook temporarily unavailable. Retry the same event ID.",
          }),
  })
const respond = (error: WebhookRejected) =>
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
  store: WebhookStore,
  request: Request,
  path: string
) {
  return Effect.gen(function* () {
    if (request.method === "GET" && path === "webhooks") {
      const id = yield* guard(() =>
        Schema.decodeUnknownSync(RoutineId)(
          new URL(request.url).searchParams.get("routine")
        )
      )
      return Response.json(yield* guard(() => store.info(id), 503))
    }
    if (request.method !== "POST")
      return new Response("Not found", { status: 404 })
    const raw = yield* asyncGuard(
      async () =>
        JSON.parse(
          new TextDecoder().decode(await boundedBytes(request, 2048))
        ) as unknown,
      400
    )
    if (path === "webhooks/cancel") {
      const { operationId } = yield* guard(() =>
        Schema.decodeUnknownSync(Schema.Struct({ operationId: RoutineId }))(raw)
      )
      return Response.json(yield* guard(() => store.cancel(operationId), 503))
    }
    if (path !== "webhooks/configure")
      return new Response("Not found", { status: 404 })
    const { key, ...input } = yield* guard(() =>
      Schema.decodeUnknownSync(ConfigureWebhook)(raw)
    )
    const hash = key ? yield* asyncGuard(() => digest(key)) : null
    return Response.json(
      yield* guard(() => store.configure({ ...input, hash }), 503)
    )
  }).pipe(Effect.catchTag("WebhookRejected", respond))
}

export function webhookIncoming(
  store: WebhookStore,
  request: Request,
  wake: () => Promise<void>
) {
  return Effect.gen(function* () {
    const id = yield* guard(() =>
      Schema.decodeUnknownSync(RoutineId)(
        new URL(request.url).searchParams.get("routine")
      )
    )
    const key = bearer(request)
    if (!key)
      return yield* new WebhookRejected({
        status: 401,
        message: "Invalid webhook authorization.",
      })
    const keyHash = yield* asyncGuard(() => digest(key))
    yield* guard(() => {
      if (!store.authorized(id, keyHash))
        reject(401, "Invalid webhook authorization.")
    }, 503)
    const eventId = yield* guard(() =>
      Schema.decodeUnknownSync(EventId)(request.headers.get("x-event-id"))
    )
    const payload = yield* asyncGuard(async () => {
      if (
        request.headers.get("content-type")?.split(";")[0]?.trim() !==
        "application/json"
      )
        reject(415, "Send application/json.")
      const value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await boundedBytes(request, MAX_EVENT_BYTES)
        )
      ) as unknown
      if (!value || typeof value !== "object" || Array.isArray(value))
        reject(400, "Send a JSON object.")
      const canonical = JSON.stringify(value)
      if (new TextEncoder().encode(canonical).length > MAX_EVENT_BYTES)
        reject(413, "The normalized JSON event exceeds 16 KB.")
      return canonical
    }, 400)
    const hash = yield* asyncGuard(() => digest(payload))
    // Establish durable wake intent before accepting a receipt, then recheck authority atomically.
    yield* asyncGuard(wake)
    const result = yield* guard(
      () => store.accept(id, keyHash, eventId, payload, hash),
      503
    )
    yield* asyncGuard(wake)
    return Response.json(result, { status: result.duplicate ? 200 : 202 })
  }).pipe(Effect.catchTag("WebhookRejected", respond))
}
