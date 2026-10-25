import { createEffectActor } from "@xstate/effect"
import { Effect, Schema } from "effect"

import { agentApi, agentUrl, api } from "@/http/client"
import { nativeOperation } from "@/shared/interop"
import { WebhookInfo } from "@/webhooks/contracts"

import { routineWorkFailures } from "./routine-work"
import { webhookUiMachine, type WebhookWork } from "./webhook-ui.machine"

export function webhookRequests(
  agentId: string,
  routineId: string
): WebhookWork {
  const decode = (value: unknown) => {
    const result = Schema.decodeUnknownSync(WebhookInfo)(value)
    if (result.routineId !== routineId)
      throw new Error("The webhook response belongs to another routine.")
    return result
  }
  const request = (path: string, body: unknown) =>
    nativeOperation(
      (signal) => agentApi(agentId)(path, body, signal),
      (cause) => cause
    )
  const read = () =>
    nativeOperation(
      async (signal) =>
        decode(
          await api(
            `${agentUrl(agentId, "webhooks")}&routine=${routineId}`,
            undefined,
            signal
          )
        ),
      (cause) => cause
    )
  return {
    read,
    change: (input) =>
      Effect.gen(function* () {
        const result = yield* request("webhooks/configure", input).pipe(
          Effect.map(decode)
        )
        const current = yield* read()
        return { result, current }
      }),
    resolve: (input) =>
      Effect.gen(function* () {
        const result = yield* request("webhooks/cancel", {
          operationId: input.operationId,
        }).pipe(
          Effect.map(
            Schema.decodeUnknownSync(Schema.Struct({ applied: Schema.Boolean }))
          )
        )
        const current = yield* read()
        return { applied: result.applied, current }
      }),
  }
}
export function makeWebhookOwner(routineId: string, work: WebhookWork) {
  return Effect.gen(function* () {
    const observe = yield* routineWorkFailures
    return yield* createEffectActor(
      webhookUiMachine({
        read: () => observe(work.read()),
        change: (input) => observe(work.change(input)),
        resolve: (input) => observe(work.resolve(input)),
      }),
      { input: { routineId } }
    )
  })
}
