import { Cause, Clock, Effect, Exit } from "effect"

import type { Turn } from "../conversations/turns"
import { preserveFatal } from "../shared/effect"
import type { RoutineAdmission, Routines } from "./service"

export interface RoutineHost<TError> {
  getTurn: (
    id: string
  ) => Effect.Effect<Pick<Turn, "id" | "status" | "error"> | undefined, TError>
  modelConnected: () => Effect.Effect<boolean, TError>
  prearm: () => Effect.Effect<number, TError>
  wakeConversation: () => Effect.Effect<void, TError>
  admission: RoutineAdmission
  stop: (id: string, discoveryDeadline?: number) => Effect.Effect<void, TError>
  notify: () => Effect.Effect<void, TError>
}

export function routinePump<TError>(
  routines: Routines["Service"],
  host: RoutineHost<TError>
) {
  return {
    retry: Effect.fn("Routines.retryWake")(function* () {
      const next = yield* routines.nextWake()
      const now = yield* Clock.currentTimeMillis
      return next === undefined ? undefined : Math.max(now + 60_000, next)
    }),
    run: Effect.fn("Routines.reconcile")(function* () {
      if ((yield* routines.nextWake()) === undefined) return
      const previous = yield* routines.inFlight()
      if (previous?.status === "queued") {
        const turn = yield* host.getTurn(previous.turnId)
        if (!turn)
          yield* routines.finish(
            previous.turnId,
            "failed",
            "The admitted reply is unavailable."
          )
        else if (
          turn.status === "done" ||
          turn.status === "failed" ||
          turn.status === "cancelled"
        )
          yield* routines.finish(turn.id, turn.status, turn.error)
        else if (!(yield* routines.canRun(turn.id))) {
          yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const armed = yield* restore(host.prearm()).pipe(Effect.exit)
              const stopped = yield* host
                .stop(turn.id, Exit.isSuccess(armed) ? armed.value : undefined)
                .pipe(Effect.exit)
              if (Exit.isFailure(armed))
                return yield* Effect.failCause(
                  Exit.isFailure(stopped)
                    ? Cause.combine(armed.cause, stopped.cause)
                    : armed.cause
                )
              if (Exit.isFailure(stopped))
                return yield* Effect.failCause(stopped.cause)
            })
          )
          yield* host.wakeConversation()
        }
      }
      yield* routines.claimDue()
      if (
        (yield* routines.inFlight())?.status === "pending" &&
        (yield* host.modelConnected())
      ) {
        const discoveryDeadline = yield* host.prearm()
        const delivered = yield* routines
          .deliver(host.admission, discoveryDeadline)
          .pipe(
            preserveFatal,
            Effect.catchTag("ConversationFull", () => Effect.void)
          )
        if (delivered) yield* host.wakeConversation()
        yield* host.notify()
      }
      const next = yield* routines.nextWake()
      const now = yield* Clock.currentTimeMillis
      return next === undefined ? undefined : Math.max(now + 100, next)
    }),
  }
}
