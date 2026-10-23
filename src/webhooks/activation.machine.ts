import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { transition } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import { reject } from "./contracts"

export const WebhookActivation = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  hash: Schema.NullOr(Schema.String),
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
})
const Context = WebhookActivation
const configure = Schema.Struct({
  expectedRevision: WebhookActivation.fields.revision,
  hash: WebhookActivation.fields.hash,
})
const change = ({
  context,
  event,
}: {
  context: typeof Context.Type
  event: typeof configure.Type
}) => {
  if (context.revision !== event.expectedRevision)
    return reject(
      "conflict",
      "The webhook changed. Resolve this request and reload before changing it."
    )
  return {
    target: event.hash ? "enabled" : "disabled",
    context: { ...context, revision: context.revision + 1, hash: event.hash },
  }
}
/** Presence of the authoritative key reconstructs availability; no second status. */
export const webhookActivationMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: Context,
    context: Context,
    events: { CONFIGURE: configure },
  },
}).createMachine({
  id: "webhook-activation",
  version: "1",
  initial: "disabled",
  context: ({ input }) => input,
  states: {
    enabled: { on: { CONFIGURE: change } },
    disabled: { on: { CONFIGURE: change } },
  },
})
export function configureWebhook(
  current: typeof Context.Type | undefined,
  expectedRevision: number,
  hash: string | null
) {
  const context = Schema.decodeUnknownSync(Context)(
    current ?? { revision: 0, hash: null, schemaVersion: 1, workflowVersion: 1 }
  )
  const [next, effects] = transition(
    webhookActivationMachine,
    webhookActivationMachine.resolveState({
      value: context.hash ? "enabled" : "disabled",
      context,
    }),
    { type: "CONFIGURE", expectedRevision, hash }
  )
  if (effects.length)
    throw new Error(
      `Unsupported webhook activation effect: ${effects[0]!.type}`
    )
  return Schema.decodeUnknownSync(Context)(next.context)
}
