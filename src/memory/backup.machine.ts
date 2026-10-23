import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { transition, type EventFromLogic } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

export const BackupStatusRecord = Schema.Struct({
  date: Schema.NullOr(Schema.String),
  watermark: Schema.String,
  error: Schema.NullOr(Schema.String),
})
export const BackupClaim = Schema.Struct({
  attemptId: Schema.String.check(Schema.isMinLength(1)),
  target: Schema.String,
  attempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
})
export type BackupClaim = typeof BackupClaim.Type
export const BackupRetry = Schema.Struct({
  attemptId: Schema.String.check(Schema.isMinLength(1)),
  target: Schema.String,
})
export type BackupRetry = typeof BackupRetry.Type
export interface BackupRecoveryLease {
  readonly deadline: number
  readonly current: () => boolean
}
const time = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const BackupControl = Schema.Struct({
  ...BackupStatusRecord.fields,
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  phase: Schema.Literals(["idle", "pending", "running", "failed"]),
  target: Schema.String,
  attempts: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
  attemptId: Schema.NullOr(Schema.String),
  retryAt: time,
}).check(
  Schema.makeFilter(
    (control) =>
      (control.phase !== "running" ||
        (control.attemptId !== null &&
          control.attemptId.length > 0 &&
          control.attempts > 0 &&
          control.retryAt === 0)) &&
      (control.phase !== "failed" ||
        (control.retryAt === 0 && control.error !== null)) &&
      (control.phase !== "idle" || control.retryAt === 0)
  )
)
export type BackupControl = typeof BackupControl.Type
export const initialBackupControl = (
  status?: typeof BackupStatusRecord.Type
): BackupControl => ({
  schemaVersion: 1,
  workflowVersion: 1,
  phase: "idle",
  target: "",
  attempts: 0,
  attemptId: null,
  retryAt: 0,
  date: status?.date ?? null,
  watermark: status?.watermark ?? "",
  error: status?.error ?? null,
})
export const BACKUP_PAUSED =
  "Backup paused after repeated failures. Retry backup or change memory to start a new attempt."
const admission = ({
  context,
  event,
}: {
  context: BackupControl
  event: { target: string; now: number; attemptId: string }
}) => {
  if (context.watermark === event.target)
    return {
      target: "idle",
      context: { ...context, phase: "idle" as const, retryAt: 0 },
    }
  if (
    context.target === event.target &&
    (context.phase === "failed" || context.retryAt > event.now)
  )
    return
  const attempts = context.target === event.target ? context.attempts + 1 : 1
  if (attempts > 3)
    return {
      target: "failed",
      context: {
        ...context,
        phase: "failed" as const,
        retryAt: 0,
        error: BACKUP_PAUSED,
      },
    }
  return {
    target: "running",
    context: {
      ...context,
      phase: "running" as const,
      target: event.target,
      attempts,
      attemptId: event.attemptId,
      retryAt: 0,
    },
  }
}
export const backupMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    context: BackupControl,
    input: BackupControl,
    events: {
      ADMIT: Schema.Struct({
        target: Schema.String,
        now: time,
        attemptId: Schema.String.check(Schema.isMinLength(1)),
      }),
      COMPLETE: Schema.Struct({
        attemptId: Schema.String.check(Schema.isMinLength(1)),
        pending: Schema.Boolean,
        date: Schema.String,
        current: Schema.String,
        now: time,
      }),
      FAILURE: Schema.Struct({
        attemptId: Schema.String.check(Schema.isMinLength(1)),
        retryable: Schema.Boolean,
        now: time,
      }),
      RESTORE: Schema.Struct({ now: time }),
      EXHAUST: Schema.Struct({ attemptId: Schema.String }),
      RETRY: Schema.Struct({ ...BackupRetry.fields, now: time }),
      RECORD: BackupStatusRecord,
      REPORT: Schema.Struct({ message: Schema.String }),
    },
  },
}).createMachine({
  id: "memory-backup",
  version: "1",
  initial: "idle",
  context: ({ input }) => input,
  on: {
    RECORD: ({ context, event }) => ({
      target: ".idle",
      context: {
        ...initialBackupControl({
          date: event.date ?? context.date,
          watermark: event.watermark,
          error: event.error,
        }),
      },
    }),
    REPORT: ({ context, event }) => ({
      context: { ...context, error: event.message },
    }),
    EXHAUST: ({ context, event }) =>
      context.attemptId === event.attemptId && context.phase !== "idle"
        ? {
            target: ".failed",
            context: {
              ...context,
              phase: "failed",
              retryAt: 0,
              error: BACKUP_PAUSED,
            },
          }
        : undefined,
  },
  states: {
    idle: { on: { ADMIT: admission } },
    pending: { on: { ADMIT: admission } },
    failed: {
      on: {
        ADMIT: admission,
        RETRY: ({ context, event }) =>
          context.attemptId === event.attemptId &&
          context.target === event.target
            ? {
                target: "pending",
                context: {
                  ...context,
                  phase: "pending",
                  attempts: 0,
                  attemptId: null,
                  retryAt: event.now,
                  error: "Backup in progress",
                },
              }
            : undefined,
      },
    },
    running: {
      on: {
        RESTORE: ({ context, event }) =>
          context.attempts >= 3
            ? {
                target: "failed",
                context: {
                  ...context,
                  phase: "failed",
                  retryAt: 0,
                  error: BACKUP_PAUSED,
                },
              }
            : {
                target: "pending",
                context: { ...context, phase: "pending", retryAt: event.now },
              },
        COMPLETE: ({ context, event }) => {
          if (context.attemptId !== event.attemptId) return
          const pending = event.pending || context.target !== event.current
          return {
            target: pending ? "pending" : "idle",
            context: {
              ...context,
              phase: pending ? "pending" : "idle",
              attempts: 0,
              retryAt: pending ? event.now + 100 : 0,
              date: event.pending ? context.date : event.date,
              watermark: event.pending ? context.watermark : context.target,
              error: event.pending ? "Backup in progress" : null,
            },
          }
        },
        FAILURE: ({ context, event }) =>
          context.attemptId !== event.attemptId
            ? undefined
            : event.retryable && context.attempts < 3
              ? {
                  target: "pending",
                  context: {
                    ...context,
                    phase: "pending",
                    retryAt: event.now + 10_000,
                    error: "Backup pending; retrying",
                  },
                }
              : {
                  target: "failed",
                  context: {
                    ...context,
                    phase: "failed",
                    retryAt: 0,
                    error: event.retryable
                      ? BACKUP_PAUSED
                      : "Backup could not be reconciled. Repair or restore memory before retrying.",
                  },
                },
      },
    },
  },
})
export type BackupEvent = EventFromLogic<typeof backupMachine>
export function decideBackup(
  state: BackupControl,
  event: BackupEvent
): BackupControl {
  const current = Schema.decodeUnknownSync(BackupControl)(state)
  const [next, effects] = transition(
    backupMachine,
    backupMachine.resolveState({ value: current.phase, context: current }),
    event
  )
  for (const effect of effects)
    if (effect.type !== "@xstate.terminate")
      throw new Error(`Unsupported backup effect: ${effect.type}`)
  return Schema.decodeUnknownSync(BackupControl)(next.context)
}
