import { preserveFatal } from "../shared/effect"
import { Clock, Effect } from "effect"
import type { Turn } from "../conversations/turns"
import type { RoutineAdmission, Routines } from "./service"

export interface RoutineHost<TError> {
  getTurn: (
    id: string
  ) => Effect.Effect<Pick<Turn, "id" | "status" | "error"> | undefined, TError>
  modelConnected: () => Effect.Effect<boolean, TError>
  wakeConversation: () => Effect.Effect<void, TError>
  admission: RoutineAdmission
  stop: (id: string) => Effect.Effect<void, TError>
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
          yield* host.wakeConversation()
          yield* host.stop(turn.id)
        }
      }
      yield* routines.claimDue()
      if (
        (yield* routines.inFlight())?.status === "pending" &&
        (yield* host.modelConnected())
      ) {
        yield* host.wakeConversation()
        yield* routines.deliver(host.admission).pipe(
          preserveFatal,
          Effect.catchTag("ConversationFull", () => Effect.void)
        )
        yield* host.notify()
      }
      const next = yield* routines.nextWake()
      const now = yield* Clock.currentTimeMillis
      return next === undefined ? undefined : Math.max(now + 100, next)
    }),
  }
}
