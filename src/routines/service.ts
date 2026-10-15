import { Schema, Clock, Context, Effect, Layer } from "effect"
import {
  conversationFailure,
  type ConversationFailure,
} from "../conversations/turns"
import { RoutineTransactions } from "./application"
import {
  RoutineConflict,
  type Routine,
  type RoutineRun,
  type RoutineChange,
  type SaveRoutine,
  type SetRoutineStatus,
  type RunRoutineNow,
} from "./contracts"
import { RoutinePersistence, RoutineStorageError } from "./persistence"

export type RoutineError = RoutineConflict | RoutineStorageError
export class Routines extends Context.Service<
  Routines,
  {
    list: () => Effect.Effect<Routine[], RoutineError>
    get: (id: string) => Effect.Effect<Routine | undefined, RoutineError>
    runs: () => Effect.Effect<RoutineRun[], RoutineError>
    inFlight: () => Effect.Effect<RoutineRun | undefined, RoutineError>
    save: (input: SaveRoutine) => Effect.Effect<RoutineChange, RoutineError>
    setStatus: (
      input: SetRoutineStatus
    ) => Effect.Effect<RoutineChange, RoutineError>
    runNow: (input: RunRoutineNow) => Effect.Effect<RoutineChange, RoutineError>
    cancelOperation: (
      id: string
    ) => Effect.Effect<{ applied: boolean }, RoutineError>
    claimDue: () => Effect.Effect<RoutineRun | undefined, RoutineError>
    deliver: (
      admission: RoutineAdmission
    ) => Effect.Effect<
      RoutineRun | undefined,
      RoutineError | ConversationFailure
    >
    finish: (
      turnId: string,
      status: "done" | "failed" | "cancelled",
      error: string | null
    ) => Effect.Effect<void, RoutineError>
    cancelPendingRun: (
      id: string
    ) => Effect.Effect<RoutineRun | undefined, RoutineError>
    canRun: (turnId: string) => Effect.Effect<boolean, RoutineError>
    nextWake: () => Effect.Effect<number | undefined, RoutineError>
  }
>()("durable-pi/routines/Routines") {}

/** Admission writes must use this group and finish before the callback returns. */
export interface RoutineAdmission {
  readonly transactionGroup: object
  readonly admit: (run: RoutineRun) => string
}

/** Synchronous authority checks for native Pi callbacks; no asynchronous gap. */
export class RoutineAuthority extends Context.Service<
  RoutineAuthority,
  {
    canRun: (turnId: string) => boolean
    nextWake: () => number | undefined
  }
>()("durable-pi/routines/Authority") {}

/** Shared aggregate transaction operations, never an independently run Effect. */
export class RoutineAdmissionState extends Context.Service<
  RoutineAdmissionState,
  {
    readonly transactionGroup: object
    readonly get: (id: string) => Routine | undefined
    readonly inFlight: () => RoutineRun | undefined
    readonly acceptWebhook: (id: string, payload: string) => RoutineRun
    readonly cancelPendingRun: (id: string) => RoutineRun | undefined
  }
>()("durable-pi/routines/AdmissionState") {}

const attempt = <TResult>(body: () => TResult) =>
  Effect.try({
    try: body,
    catch(cause) {
      const knownFailure = Schema.decodeUnknownOption(
        Schema.Union([RoutineConflict, RoutineStorageError])
      )(cause)
      if (knownFailure._tag === "Some") return knownFailure.value
      throw cause // Corrupt records and programming errors remain defects.
    },
  })

export function makeRoutineApplication(
  records: RoutinePersistence["Service"],
  active: () => boolean,
  now: () => number,
  uuid: () => string
) {
  const tx = new RoutineTransactions(records, active, now, uuid)
  const service = Routines.of({
    list: Effect.fn("Routines.list")(() => attempt(() => tx.list())),
    get: Effect.fn("Routines.get")((id: string) => attempt(() => tx.get(id))),
    runs: Effect.fn("Routines.runs")(() => attempt(() => tx.runs())),
    inFlight: Effect.fn("Routines.inFlight")(() =>
      attempt(() => tx.inFlight())
    ),
    save: Effect.fn("Routines.save")((input: SaveRoutine) =>
      attempt(() => tx.save(input))
    ),
    setStatus: Effect.fn("Routines.setStatus")((input: SetRoutineStatus) =>
      attempt(() => tx.setStatus(input))
    ),
    runNow: Effect.fn("Routines.runNow")((input: RunRoutineNow) =>
      attempt(() => tx.runNow(input))
    ),
    cancelOperation: Effect.fn("Routines.cancelOperation")((id: string) =>
      attempt(() => tx.cancelOperation(id))
    ),
    claimDue: Effect.fn("Routines.claimDue")(() =>
      attempt(() => tx.claimDue())
    ),
    deliver: Effect.fn("Routines.deliver")((admission: RoutineAdmission) =>
      Effect.try({
        try: () => {
          if (admission.transactionGroup !== records.transactionGroup)
            throw new Error(
              "Routine admission must share its storage transaction group."
            )
          return tx.deliver((run) => {
            if (admission.admit(run) !== run.turnId)
              throw new Error(
                "Routine admission returned a different turn identity."
              )
          })
        },
        catch(cause) {
          const failure = conversationFailure(cause)
          if (failure) return failure
          const knownFailure2 = Schema.decodeUnknownOption(
            Schema.Union([RoutineConflict, RoutineStorageError])
          )(cause)
          if (knownFailure2._tag === "Some") return knownFailure2.value
          throw cause
        },
      })
    ),
    finish: Effect.fn("Routines.finish")(
      (
        id: string,
        status: "done" | "failed" | "cancelled",
        error: string | null
      ) => attempt(() => tx.finish(id, status, error))
    ),
    cancelPendingRun: Effect.fn("Routines.cancelPendingRun")((id: string) =>
      attempt(() => tx.cancelPendingRun(id))
    ),
    canRun: Effect.fn("Routines.canRun")((id: string) =>
      attempt(() => tx.canRun(id))
    ),
    nextWake: Effect.fn("Routines.nextWake")(() =>
      attempt(() => tx.nextWake())
    ),
  })
  return Context.make(Routines, service).pipe(
    Context.add(RoutineAuthority, {
      canRun: (id) => tx.canRun(id),
      nextWake: () => tx.nextWake(),
    }),
    Context.add(RoutineAdmissionState, {
      transactionGroup: records.transactionGroup,
      get: (id) => tx.get(id),
      inFlight: () => tx.inFlight(),
      acceptWebhook: (id, payload) => tx.acceptWebhook(id, payload),
      cancelPendingRun: (id) => tx.cancelPendingRun(id),
    })
  )
}

export const routineApplication = (active: () => boolean, uuid: () => string) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const records = yield* RoutinePersistence
      const clock = yield* Clock.Clock
      return makeRoutineApplication(
        records,
        active,
        () => clock.currentTimeMillisUnsafe(),
        uuid
      )
    })
  )
