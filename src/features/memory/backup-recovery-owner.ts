import { createEffectActor, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Equal, Exit, type Scope } from "effect"

import { orDieAll } from "@/shared/effect"

import {
  backupRecoveryMachine,
  type BackupRecoveryView,
  type BackupRecoveryRequest,
} from "./backup-recovery.machine"

/** Retain late invocation failures while the component joins scope cleanup. */
export function makeBackupRecovery(
  view: BackupRecoveryView,
  request: (
    input: BackupRecoveryRequest
  ) => Effect.Effect<void, unknown, Scope.Scope>
) {
  return Effect.gen(function* () {
    let failed: Cause.Cause<unknown> | undefined
    let actor: EffectActor<ReturnType<typeof backupRecoveryMachine>> | undefined
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        const outcome = actor?.getSnapshot().context.outcome
        const retained =
          outcome && Exit.isFailure(outcome) ? outcome.cause.reasons : []
        const missing =
          failed?.reasons.filter(
            (reason) =>
              reason._tag !== "Interrupt" &&
              !retained.some((present) => Equal.equals(present, reason))
          ) ?? []
        return missing.length
          ? Effect.failCause(Cause.fromReasons(missing)).pipe(orDieAll)
          : Effect.void
      })
    )
    actor = yield* createEffectActor(
      backupRecoveryMachine((input) =>
        Effect.suspend(() => {
          failed = undefined
          return request(input)
        }).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              failed = Exit.isFailure(exit) ? exit.cause : undefined
            })
          )
        )
      ),
      { input: view }
    )
    return actor
  })
}
