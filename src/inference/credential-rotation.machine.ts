import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { transition } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

const id = Schema.String.check(Schema.isMinLength(1))
export const CredentialRotation = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  phase: Schema.Literals(["ready", "refreshing", "unconfirmed"]),
  connectionId: Schema.NullOr(id),
  attemptId: Schema.NullOr(id),
})
export type CredentialRotation = typeof CredentialRotation.Type
export const readyRotation = (
  connectionId: string | null
): CredentialRotation => ({
  schemaVersion: 1,
  workflowVersion: 1,
  phase: "ready",
  connectionId,
  attemptId: null,
})
const correlated = Schema.Struct({ connectionId: id, attemptId: id })
const RotationEvent = Schema.Struct({
  type: Schema.Literals(["CLAIM", "COMPLETE", "UNCERTAIN"]),
  ...correlated.fields,
})
export const credentialRotationMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    context: CredentialRotation,
    events: { CLAIM: correlated, COMPLETE: correlated, UNCERTAIN: correlated },
  },
}).createMachine({
  id: "credential-rotation",
  version: "1",
  initial: "ready",
  context: () => readyRotation(null),
  states: {
    ready: {
      on: {
        CLAIM: ({ context, event }) =>
          context.connectionId === event.connectionId
            ? {
                target: "refreshing",
                context: {
                  ...context,
                  phase: "refreshing",
                  attemptId: event.attemptId,
                },
              }
            : undefined,
      },
    },
    refreshing: {
      on: {
        COMPLETE: ({ context, event }) =>
          context.connectionId === event.connectionId &&
          context.attemptId === event.attemptId
            ? {
                target: "ready",
                context: readyRotation(context.connectionId),
              }
            : undefined,
        UNCERTAIN: ({ context, event }) =>
          context.connectionId === event.connectionId &&
          context.attemptId === event.attemptId
            ? {
                target: "unconfirmed",
                context: { ...context, phase: "unconfirmed" },
              }
            : undefined,
      },
    },
    unconfirmed: {},
  },
})
export function advanceCredentialRotation(
  saved: CredentialRotation,
  event: {
    type: "CLAIM" | "COMPLETE" | "UNCERTAIN"
    connectionId: string
    attemptId: string
  }
): CredentialRotation {
  const context = Schema.decodeUnknownSync(CredentialRotation)(saved)
  const [next] = transition(
    credentialRotationMachine,
    credentialRotationMachine.resolveState({ value: context.phase, context }),
    Schema.decodeUnknownSync(RotationEvent)(event)
  )
  return Schema.decodeUnknownSync(CredentialRotation)(next.context)
}
