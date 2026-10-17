import { Context, Effect, Layer } from "effect"

import type { RoutineStorageError } from "../routines/persistence"
import { RoutineAdmissionState } from "../routines/service"
import { WebhookTransactions } from "./application"
import type {
  WebhookRejected,
  ConfigureWebhook,
  WebhookInfo,
} from "./contracts"
import type { WebhookStorageError } from "./persistence"
import { WebhookPersistence } from "./persistence"

export type WebhookError =
  | WebhookRejected
  | WebhookStorageError
  | RoutineStorageError
export type WebhookConfiguration = Omit<ConfigureWebhook, "key"> & {
  hash: string | null
}
export class Webhooks extends Context.Service<
  Webhooks,
  {
    info: (id: string) => Effect.Effect<WebhookInfo, WebhookError>
    configure: (
      input: WebhookConfiguration
    ) => Effect.Effect<WebhookInfo, WebhookError>
    cancel: (
      operationId: string
    ) => Effect.Effect<{ applied: boolean }, WebhookError>
    authorized: (
      id: string,
      hash: string
    ) => Effect.Effect<boolean, WebhookError>
    accept: (
      id: string,
      keyHash: string,
      eventId: string,
      payload: string,
      payloadHash: string
    ) => Effect.Effect<{ runId: string; duplicate: boolean }, WebhookError>
  }
>()("durable-pi/webhooks/Webhooks") {}

export function makeWebhooks(
  records: WebhookPersistence["Service"],
  routines: RoutineAdmissionState["Service"],
  active: () => Effect.Effect<boolean, WebhookStorageError>
) {
  const tx = new WebhookTransactions(records, routines, active)
  return Webhooks.of({
    info: Effect.fn("Webhooks.info")((id: string) => tx.info(id)),
    configure: Effect.fn("Webhooks.configure")((input: WebhookConfiguration) =>
      tx.configure(input)
    ),
    cancel: Effect.fn("Webhooks.cancel")((id: string) => tx.cancel(id)),
    authorized: Effect.fn("Webhooks.authorized")((id: string, hash: string) =>
      tx.authorized(id, hash)
    ),
    accept: Effect.fn("Webhooks.accept")(
      (
        id: string,
        hash: string,
        eventId: string,
        payload: string,
        payloadHash: string
      ) => tx.accept(id, hash, eventId, payload, payloadHash)
    ),
  })
}
export const webhookApplication = (
  active: () => Effect.Effect<boolean, WebhookStorageError>
) =>
  Layer.effect(
    Webhooks,
    Effect.gen(function* () {
      return makeWebhooks(
        yield* WebhookPersistence,
        yield* RoutineAdmissionState,
        active
      )
    })
  )
