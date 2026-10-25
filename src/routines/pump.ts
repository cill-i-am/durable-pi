import { createEffectActor, waitFor } from "@xstate/effect"
import { Cause, Clock, Effect, Exit, Semaphore } from "effect"

import type { ConversationFailure, Turn } from "../conversations/turns"
import { preserveFatal } from "../shared/effect"
import {
  routinePumpMachine,
  type RoutinePumpContext,
  type RoutinePumpWork,
} from "./pump.machine"
import { readRoutineRunRecord } from "./run.machine"
import type { RoutineAdmission, RoutineError, Routines } from "./service"

export interface RoutineHost<TError> {
  getTurn: (
    id: string
  ) => Effect.Effect<Pick<Turn, "id" | "status" | "error"> | undefined, TError>
  modelConnected: () => Effect.Effect<boolean, TError>
  /** Refresh current authority after awaited preparation, before admission. */
  canAdmit: () => Effect.Effect<boolean, TError>
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
  type E = TError | RoutineError | ConversationFailure
  type C = RoutinePumpContext<E>
  // Scope closure (including native finalizers) completes before another local
  // observer can enter. This lock grants no native/Pi execution ownership.
  const occupancy = Semaphore.makeUnsafe(1)
  const keep = (c: C, effect: Effect.Effect<unknown, E>) =>
    effect.pipe(Effect.as(c))
  const work: RoutinePumpWork<E> = {
    discover: (c) =>
      Effect.gen(function* () {
        const eligible = (yield* routines.nextWake()) !== undefined
        return {
          ...c,
          eligible,
          run: eligible ? yield* routines.reconcile() : undefined,
        }
      }),
    observe: (c) =>
      host.getTurn(c.run!.turnId).pipe(Effect.map((turn) => ({ ...c, turn }))),
    finish: (c) =>
      keep(
        c,
        routines.finish(
          c.run!.turnId,
          c.turn?.status === "done" || c.turn?.status === "cancelled"
            ? c.turn.status
            : "failed",
          c.turn?.error ??
            (c.turn ? null : "The admitted reply is unavailable.")
        )
      ),
    stop: (c) =>
      keep(
        c,
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const armed = yield* restore(host.prearm()).pipe(Effect.exit)
            const stopped = yield* host
              .stop(
                c.run!.turnId,
                Exit.isSuccess(armed) ? armed.value : undefined
              )
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
      ),
    claim: (c) =>
      Effect.gen(function* () {
        yield* routines.claimDue()
        return { ...c, run: yield* routines.inFlight() }
      }),
    model: (c) =>
      host
        .modelConnected()
        .pipe(Effect.map((connected) => ({ ...c, connected }))),
    arm: (c) =>
      host.prearm().pipe(Effect.map((deadline) => ({ ...c, deadline }))),
    authority: (c) =>
      host
        .canAdmit()
        .pipe(Effect.map((allowDispatch) => ({ ...c, allowDispatch }))),
    deliver: (c) =>
      routines.deliver(host.admission, c.deadline).pipe(
        preserveFatal,
        Effect.catchTag("ConversationFull", () => Effect.void),
        Effect.map((delivered) => ({
          ...c,
          run: delivered || c.run,
          delivered: !!delivered,
        }))
      ),
    wake: (c) => keep(c, host.wakeConversation()),
    notify: (c) => keep(c, host.notify()),
    schedule: (c) =>
      Effect.gen(function* () {
        const next = yield* routines.nextWake()
        const now = yield* Clock.currentTimeMillis
        const live = yield* routines.inFlight()
        const permitted = c.allowDispatch || (live && live.status !== "pending")
        return {
          ...c,
          outcome: Exit.succeed(
            next === undefined || !permitted
              ? undefined
              : Math.max(now + 100, next)
          ),
        }
      }),
  }
  return {
    run: Effect.fn("Routines.reconcile")(
      (
        onAttempt?: (attempt: { id: string; controlRevision: number }) => void,
        options: { allowDispatch?: boolean } = {}
      ) =>
        Effect.gen(function* () {
          const actor = yield* createEffectActor(
            routinePumpMachine(
              {
                ...work,
                discover: (c) =>
                  work.discover(c).pipe(
                    Effect.tap((next) =>
                      Effect.sync(() => {
                        if (next.run)
                          onAttempt?.(readRoutineRunRecord(next.run))
                      })
                    )
                  ),
                deliver: (c) =>
                  work.deliver(c).pipe(
                    Effect.tap((next) =>
                      Effect.sync(() => {
                        if (next.run)
                          onAttempt?.(readRoutineRunRecord(next.run))
                      })
                    )
                  ),
                claim: (c) =>
                  work.claim(c).pipe(
                    Effect.tap((next) =>
                      Effect.sync(() => {
                        if (next.run)
                          onAttempt?.(readRoutineRunRecord(next.run))
                      })
                    )
                  ),
              },
              options.allowDispatch !== false
            )
          )
          const done = yield* waitFor(
            actor,
            (state) => state.status === "done"
          ).pipe(Effect.orDie)
          return yield* done.output!
        }).pipe(Effect.scoped, occupancy.withPermit)
    ),
  }
}
