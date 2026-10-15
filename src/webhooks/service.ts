import { Schema, Context, Effect, Layer } from "effect"
import { RoutineAdmissionState } from "../routines/service"
import { RoutineStorageError } from "../routines/persistence"
import { RoutineConflict } from "../routines/contracts"
import { WebhookTransactions } from "./application"
import {
  WebhookRejected,
  type ConfigureWebhook,
  type WebhookInfo,
} from "./contracts"
import { WebhookPersistence, WebhookStorageError } from "./persistence"

export type WebhookError =
  WebhookRejected | WebhookStorageError | RoutineStorageError
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

const attempt = <TResult>(body: () => TResult) =>
  Effect.try({
    try: body,
    catch(cause) {
      const knownFailure = Schema.decodeUnknownOption(
        Schema.Union([
          WebhookRejected,
          WebhookStorageError,
          RoutineStorageError,
        ])
      )(cause)
      if (knownFailure._tag === "Some") return knownFailure.value
      const routineConflict = Schema.decodeUnknownOption(RoutineConflict)(cause)
      if (routineConflict._tag === "Some")
        return new WebhookRejected({
          reason: "conflict",
          message: routineConflict.value.message,
        })
      throw cause
    },
  })

export function makeWebhooks(
  records: WebhookPersistence["Service"],
  routines: RoutineAdmissionState["Service"],
  active: () => boolean
) {
  const tx = new WebhookTransactions(records, routines, active)
  return Webhooks.of({
    info: Effect.fn("Webhooks.info")((id: string) =>
      attempt(() => tx.info(id))
    ),
    configure: Effect.fn("Webhooks.configure")((input: WebhookConfiguration) =>
      attempt(() => tx.configure(input))
    ),
    cancel: Effect.fn("Webhooks.cancel")((id: string) =>
      attempt(() => tx.cancel(id))
    ),
    authorized: Effect.fn("Webhooks.authorized")((id: string, hash: string) =>
      attempt(() => tx.authorized(id, hash))
    ),
    accept: Effect.fn("Webhooks.accept")(
      (
        id: string,
        hash: string,
        eventId: string,
        payload: string,
        payloadHash: string
      ) => attempt(() => tx.accept(id, hash, eventId, payload, payloadHash))
    ),
  })
}
export const webhookApplication = (active: () => boolean) =>
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
