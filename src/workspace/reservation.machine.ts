import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { transition, type EventFromLogic } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

const Context = Schema.Struct({ attemptId: Schema.NullOr(Schema.String) })
export const reservationMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    context: Context,
    events: {
      CLAIM: Schema.Struct({
        attemptId: Schema.String.check(Schema.isMinLength(1)),
      }),
      READY: Schema.Struct({
        attemptId: Schema.String.check(Schema.isMinLength(1)),
      }),
    },
  },
}).createMachine({
  id: "workspace-reservation",
  version: "1",
  context: { attemptId: null },
  initial: "uploading",
  states: {
    uploading: {
      on: {
        CLAIM: ({ context, event }) => ({
          context: { ...context, attemptId: event.attemptId },
        }),
        READY: ({ context, event }) =>
          context.attemptId === event.attemptId
            ? { target: "ready" }
            : undefined,
      },
    },
    ready: {},
  },
})

export function decideReservation(
  saved: {
    status: "uploading" | "ready"
    lifecycleVersion?: number
    attemptId?: string | null
  },
  event: EventFromLogic<typeof reservationMachine>
) {
  if (
    saved.lifecycleVersion !== undefined &&
    saved.lifecycleVersion !== 0 &&
    saved.lifecycleVersion !== 1
  )
    throw new Error("Unsupported Workspace reservation version")
  const context = Schema.decodeUnknownSync(Context)({
    attemptId: saved.attemptId ?? null,
  })
  const [next, effects] = transition(
    reservationMachine,
    reservationMachine.resolveState({ value: saved.status, context }),
    event
  )
  if (effects.length)
    throw new Error("Unsupported Workspace reservation effect")
  return {
    status: next.value as "uploading" | "ready",
    lifecycleVersion: 1,
    attemptId: next.context.attemptId,
  }
}
