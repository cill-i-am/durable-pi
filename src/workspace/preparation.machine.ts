import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { transition, type EventFromLogic } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

export const WORKSPACE_RECOVERY_MS = 10 * 60_000

const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const token = Schema.String.check(Schema.isMinLength(1))
const Context = Schema.Struct({
  attempts: count,
  attemptId: Schema.NullOr(Schema.String),
  artifactHash: Schema.NullOr(Schema.String),
  retryAt: count,
  recoveryDeadline: count,
  error: Schema.NullOr(Schema.String),
})
const retry = ({
  context,
  event,
}: {
  context: typeof Context.Type
  event: { now: number }
}) => ({
  target: "pending",
  context: {
    ...context,
    attempts: 0,
    recoveryDeadline: event.now + WORKSPACE_RECOVERY_MS,
    attemptId: null,
    retryAt: 0,
    error: null,
  },
})
export const preparationMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    context: Context,
    events: {
      CLAIM: Schema.Struct({ attemptId: token, now: count }),
      COMPLETE: Schema.Struct({
        attemptId: token,
        artifactHash: Schema.NullOr(Schema.String),
        empty: Schema.Boolean,
        error: Schema.NullOr(Schema.String),
      }),
      FAILURE: Schema.Struct({
        attemptId: token,
        retryable: Schema.Boolean,
        retryAt: count,
        now: count,
        error: Schema.String,
      }),
      EXHAUST: Schema.Struct({ attemptId: token }),
      DEFER: Schema.Struct({ attemptId: token, now: count }),
      EXPIRE: Schema.Struct({ now: count }),
      EXPIRE_JOINED: Schema.Struct({ now: count, attemptId: token }),
      RESTORE: Schema.Struct({}),
      RETRY: Schema.Struct({ now: count }),
    },
  },
}).createMachine({
  id: "workspace-preparation",
  version: "1",
  context: {
    attempts: 0,
    attemptId: null,
    artifactHash: null,
    retryAt: 0,
    recoveryDeadline: 0,
    error: null,
  },
  initial: "pending",
  states: {
    pending: {
      on: {
        EXPIRE: ({ context, event }) =>
          event.now >= context.recoveryDeadline
            ? {
                target: "failed",
                context: {
                  ...context,
                  error: "Preparation recovery expired. Retry from Files.",
                },
              }
            : undefined,
        EXHAUST: ({ context, event }) =>
          context.attemptId === event.attemptId
            ? {
                target: "failed",
                context: {
                  ...context,
                  error:
                    "Preparation recovery was exhausted. Retry from Files.",
                },
              }
            : undefined,
        CLAIM: ({ context, event }) => {
          if (event.now >= context.recoveryDeadline)
            return {
              target: "failed",
              context: {
                ...context,
                error: "Preparation recovery expired. Retry from Files.",
              },
            }
          if (context.retryAt > event.now) return
          if (context.attempts >= 3)
            return {
              target: "failed",
              context: {
                ...context,
                error: "Preparation was interrupted. Retry from Files.",
              },
            }
          return {
            target: "running",
            context: {
              ...context,
              attempts: context.attempts + 1,
              recoveryDeadline: event.now + WORKSPACE_RECOVERY_MS,
              attemptId: event.attemptId,
              error: null,
            },
          }
        },
      },
    },
    running: {
      on: {
        EXPIRE_JOINED: ({ context, event }) =>
          context.attemptId === event.attemptId &&
          event.now >= context.recoveryDeadline
            ? {
                target: "failed",
                context: {
                  ...context,
                  error: "Preparation recovery expired. Retry from Files.",
                },
              }
            : undefined,
        EXHAUST: ({ context, event }) =>
          context.attemptId === event.attemptId
            ? {
                target: "failed",
                context: {
                  ...context,
                  error:
                    "Preparation recovery was exhausted. Retry from Files.",
                },
              }
            : undefined,
        COMPLETE: ({ context, event }) =>
          context.attemptId === event.attemptId
            ? {
                target: event.empty ? "empty" : "ready",
                context: {
                  ...context,
                  artifactHash: event.artifactHash,
                  retryAt: 0,
                  error: event.error,
                },
              }
            : undefined,
        FAILURE: ({ context, event }) =>
          context.attemptId === event.attemptId
            ? {
                target:
                  event.retryable && context.attempts < 3
                    ? "pending"
                    : "failed",
                context: {
                  ...context,
                  retryAt: event.retryAt,
                  recoveryDeadline: event.now + WORKSPACE_RECOVERY_MS,
                  error:
                    event.retryable && context.attempts < 3
                      ? null
                      : event.error,
                },
              }
            : undefined,
        DEFER: ({ context, event }) =>
          context.attemptId === event.attemptId
            ? {
                target: "pending",
                context: {
                  ...context,
                  recoveryDeadline: event.now + WORKSPACE_RECOVERY_MS,
                  error: null,
                },
              }
            : undefined,
        RESTORE: ({ context }) => ({
          target: context.attempts < 3 ? "pending" : "failed",
          context: {
            ...context,
            attemptId: null,
            error:
              context.attempts < 3
                ? null
                : "Preparation was interrupted. Retry from Files.",
          },
        }),
      },
    },
    ready: {},
    empty: { on: { RETRY: retry } },
    failed: { on: { RETRY: retry } },
  },
})
export type PreparationEvent = EventFromLogic<typeof preparationMachine>
export function decidePreparation(
  saved: {
    status: "pending" | "running" | "ready" | "empty" | "failed"
    attempts: number
    lifecycleVersion?: number
    attemptId?: string | null
    artifactHash?: string | null
    retryAt?: number
    recoveryDeadline?: number
    error: string | null
  },
  event: PreparationEvent
) {
  if (
    saved.lifecycleVersion !== undefined &&
    saved.lifecycleVersion !== 0 &&
    saved.lifecycleVersion !== 1
  )
    throw new Error("Unsupported Workspace preparation version")
  const context = Schema.decodeUnknownSync(Context)({
    ...saved,
    attemptId: saved.attemptId ?? null,
    artifactHash: saved.artifactHash ?? null,
    retryAt: saved.retryAt ?? 0,
    recoveryDeadline: saved.recoveryDeadline ?? 0,
  })
  const [next, effects] = transition(
    preparationMachine,
    preparationMachine.resolveState({ value: saved.status, context }),
    event
  )
  if (effects.length)
    throw new Error("Unsupported Workspace preparation effect")
  return {
    status: next.value as typeof saved.status,
    lifecycleVersion: 1,
    ...next.context,
  }
}
