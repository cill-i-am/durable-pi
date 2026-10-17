import { Clock, Context, Effect, Layer } from "effect"

import { type ConversationFailure } from "../conversations/turns"
import { RoutineTransactions } from "./application"
import type {
  RoutineConflict,
  Routine,
  RoutineRun,
  RoutineChange,
  SaveRoutine,
  SetRoutineStatus,
  RunRoutineNow,
} from "./contracts"
import type { RoutineStorageError } from "./persistence"
import { RoutinePersistence } from "./persistence"

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
  readonly admit: (
    run: RoutineRun
  ) => Effect.Effect<string, ConversationFailure>
}

/** Authority reads compose in the caller's actor transaction. */
export class RoutineAuthority extends Context.Service<
  RoutineAuthority,
  {
    canRun: (turnId: string) => Effect.Effect<boolean, RoutineError>
    nextWake: () => Effect.Effect<number | undefined, RoutineError>
  }
>()("durable-pi/routines/Authority") {}

/** Shared aggregate operations join the current actor transaction. */
export class RoutineAdmissionState extends Context.Service<
  RoutineAdmissionState,
  {
    readonly transactionGroup: object
    readonly get: (
      id: string
    ) => Effect.Effect<Routine | undefined, RoutineError>
    readonly inFlight: () => Effect.Effect<RoutineRun | undefined, RoutineError>
    readonly acceptWebhook: (
      id: string,
      payload: string
    ) => Effect.Effect<RoutineRun, RoutineError>
    readonly cancelPendingRun: (
      id: string
    ) => Effect.Effect<RoutineRun | undefined, RoutineError>
  }
>()("durable-pi/routines/AdmissionState") {}

export function makeRoutineApplication(
  records: RoutinePersistence["Service"],
  active: () => Effect.Effect<boolean, RoutineStorageError>,
  now: () => number,
  uuid: () => string
) {
  const tx = new RoutineTransactions(records, active, now, uuid)
  const service = Routines.of({
    list: Effect.fn("Routines.list")(() => tx.list()),
    get: Effect.fn("Routines.get")((id: string) => tx.get(id)),
    runs: Effect.fn("Routines.runs")(() => tx.runs()),
    inFlight: Effect.fn("Routines.inFlight")(() => tx.inFlight()),
    save: Effect.fn("Routines.save")((input: SaveRoutine) => tx.save(input)),
    setStatus: Effect.fn("Routines.setStatus")((input: SetRoutineStatus) =>
      tx.setStatus(input)
    ),
    runNow: Effect.fn("Routines.runNow")((input: RunRoutineNow) =>
      tx.runNow(input)
    ),
    cancelOperation: Effect.fn("Routines.cancelOperation")((id: string) =>
      tx.cancelOperation(id)
    ),
    claimDue: Effect.fn("Routines.claimDue")(() => tx.claimDue()),
    deliver: Effect.fn("Routines.deliver")((admission: RoutineAdmission) =>
      Effect.suspend(() => {
        if (admission.transactionGroup !== records.transactionGroup)
          throw new Error(
            "Routine admission must share its storage transaction group."
          )
        return tx.deliver((run) =>
          admission.admit(run).pipe(
            Effect.map((id) => {
              if (id !== run.turnId)
                throw new Error(
                  "Routine admission returned a different turn identity."
                )
            })
          )
        )
      })
    ),
    finish: Effect.fn("Routines.finish")(
      (
        id: string,
        status: "done" | "failed" | "cancelled",
        error: string | null
      ) => tx.finish(id, status, error)
    ),
    cancelPendingRun: Effect.fn("Routines.cancelPendingRun")((id: string) =>
      tx.cancelPendingRun(id)
    ),
    canRun: Effect.fn("Routines.canRun")((id: string) => tx.canRun(id)),
    nextWake: Effect.fn("Routines.nextWake")(() => tx.nextWake()),
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

export const routineApplication = (
  active: () => Effect.Effect<boolean, RoutineStorageError>,
  uuid: () => string
) =>
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
