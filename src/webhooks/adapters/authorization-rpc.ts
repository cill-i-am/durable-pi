import { Cause, Schema } from "effect"

import { RoutineId } from "../../routines/contracts"
import { rpcOutcome } from "../../shared/rpc-outcome"
import { WebhookKey } from "../contracts"

export const WebhookAuthorizationRequest = Schema.Struct({
  id: RoutineId,
  key: WebhookKey,
})
export const WebhookAuthorizationFailure = Schema.Struct({
  _tag: Schema.Literals([
    "WebhookRejected",
    "WebhookStorageError",
    "RoutineStorageError",
  ]),
})
export const WebhookAuthorizationOutcome = rpcOutcome(
  Schema.Boolean,
  WebhookAuthorizationFailure,
  "Webhook authorization failed unexpectedly."
)
export interface WebhookAuthorizationRpc {
  webhookAuthorizationV1?: (
    input: typeof WebhookAuthorizationRequest.Type
  ) => Promise<unknown>
  webhookAuthorized?: (id: string, key: string) => Promise<unknown>
}
export function webhookAuthorizationRpc(stub: WebhookAuthorizationRpc) {
  const previous = (id: string, key: string) => {
    if (!stub.webhookAuthorized)
      return Promise.reject(
        new Error("Previous webhook authorization is unavailable")
      )
    return stub.webhookAuthorized(id, key).then((raw) => {
      try {
        return Schema.decodeUnknownSync(Schema.Boolean)(raw)
      } catch (cause) {
        throw Cause.die(cause)
      }
    })
  }
  return {
    authorized: (id: string, key: string) => {
      if (!Schema.is(RoutineId)(id) || !Schema.is(WebhookKey)(key))
        return Promise.resolve(false)
      if (!stub.webhookAuthorizationV1) return previous(id, key)
      return stub.webhookAuthorizationV1({ id, key }).then(
        (raw) => WebhookAuthorizationOutcome.unwrap(raw, Schema.Boolean),
        (cause: unknown) => {
          if (Cause.isCause(cause) || Schema.isSchemaError(cause)) throw cause
          return previous(id, key)
        }
      )
    },
  }
}
