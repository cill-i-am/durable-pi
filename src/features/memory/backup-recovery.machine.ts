import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { BackupRecovery, CompactionRecovery } from "@/conversations/contracts"

export const backupRecoveryView = Schema.Struct({
  recovery: Schema.NullOr(BackupRecovery),
  schedulerRecovery: Schema.NullOr(CompactionRecovery),
})
export type BackupRecoveryView = typeof backupRecoveryView.Type
export const sameBackupRecovery = (
  left: BackupRecovery | null,
  right: BackupRecovery | null
) =>
  left !== null &&
  right !== null &&
  left.attemptId === right.attemptId &&
  left.target === right.target
export const backupRecoveryRequest = Schema.Union([
  BackupRecovery,
  Schema.Struct({ epoch: Schema.String }),
])
export type BackupRecoveryRequest = typeof backupRecoveryRequest.Type
export const currentBackupRecovery = (
  view: BackupRecoveryView,
  request: BackupRecoveryRequest | null
) =>
  request !== null &&
  ("epoch" in request
    ? view.schedulerRecovery?.epoch === request.epoch
    : !view.schedulerRecovery && sameBackupRecovery(view.recovery, request))
const outcome = Schema.declare((value): value is Exit.Exit<void, unknown> =>
  Exit.isExit(value)
)
const context = Schema.Struct({
  ...backupRecoveryView.fields,
  request: Schema.NullOr(backupRecoveryRequest),
  outcome: Schema.UndefinedOr(outcome),
})

/** A retry acknowledges one failed backup owner, never a completed backup. */
export function backupRecoveryMachine(
  request: (
    input: BackupRecoveryRequest
  ) => Effect.Effect<void, unknown, Scope.Scope>
) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: backupRecoveryView,
      context,
      events: { VIEW: backupRecoveryView, SUBMIT: backupRecoveryRequest },
    },
    actors: {
      request: createEffectLogic(
        ({ input }: { input: BackupRecoveryRequest }) =>
          Effect.exit(request(input))
      ),
    },
  }).createMachine({
    id: "memory-backup-recovery",
    initial: "ready",
    context: ({ input }) => ({ ...input, request: null, outcome: undefined }),
    on: {
      VIEW: ({ context, event }) => ({
        context: {
          ...context,
          recovery: event.recovery,
          schedulerRecovery: event.schedulerRecovery,
        },
      }),
    },
    states: {
      ready: {
        on: {
          SUBMIT: ({ context, event }) => {
            const request = Schema.decodeUnknownSync(backupRecoveryRequest)(
              event
            )
            return currentBackupRecovery(context, request)
              ? {
                  target: "requesting",
                  context: {
                    ...context,
                    request,
                    outcome: undefined,
                  },
                }
              : undefined
          },
        },
      },
      requesting: {
        invoke: {
          src: "request",
          input: ({ context }) => context.request!,
          onDone: ({ context, event }) => ({
            target: "settled",
            context: { ...context, outcome: event.output },
          }),
        },
      },
      settled: {
        always: ({ context }) =>
          !currentBackupRecovery(context, context.request) ||
          (context.outcome && Exit.isFailure(context.outcome))
            ? { target: "ready" }
            : undefined,
      },
    },
  })
}
