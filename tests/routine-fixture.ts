import type { Clock } from "effect"
import { Cause, Context, Effect, Exit } from "effect"

import type { ConversationFailure } from "../src/conversations/turns"
import { SqliteRoutinePersistence } from "../src/routines/adapters/sqlite"
import type {
  RoutineRun,
  SaveRoutine,
  SetRoutineStatus,
  RunRoutineNow,
} from "../src/routines/contracts"
import {
  makeRoutineApplication,
  Routines,
  RoutineAdmissionState,
} from "../src/routines/service"
import type { Sqlite } from "../src/storage/sqlite"
import { SqliteWebhookPersistence } from "../src/webhooks/adapters/sqlite"
import {
  makeWebhooks,
  type WebhookConfiguration,
} from "../src/webhooks/service"

// Foreign test boundaries expose thrown values for the existing storage-law
// assertions. Production consumers use the service's Effects.
export function run<TResult, TError>(
  operation: Effect.Effect<TResult, TError>
): TResult {
  const exit = Effect.runSyncExit(operation)
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
  return exit.value
}

export function routineFixture(
  db: Sqlite,
  active: () => boolean,
  now: () => number = Date.now
) {
  const context = makeRoutineApplication(
    new SqliteRoutinePersistence(db),
    () => Effect.sync(active),
    now,
    () => crypto.randomUUID()
  )
  const service = Context.get(context, Routines)
  return {
    service,
    transactionGroup: db,
    admissionState: Context.get(context, RoutineAdmissionState),
    list: () => run(service.list()),
    get: (id: string) => run(service.get(id)),
    runs: () => run(service.runs()),
    inFlight: () => run(service.inFlight()),
    save: (input: SaveRoutine) => run(service.save(input, now() + 60_000)),
    setStatus: (input: SetRoutineStatus) =>
      run(service.setStatus(input, now() + 60_000)),
    runNow: (input: RunRoutineNow) =>
      run(service.runNow(input, now() + 60_000)),
    cancelOperation: (id: string) => run(service.cancelOperation(id)),
    claimDue: () => run(service.claimDue()),
    deliver: (
      admit: (
        value: RoutineRun,
        discoveryDeadline: number
      ) => void | Effect.Effect<unknown, ConversationFailure>,
      discoveryDeadline: number
    ) =>
      run(
        service.deliver(
          {
            transactionGroup: db,
            admit: (value, deadline) =>
              Effect.suspend(() => {
                const work = admit(value, deadline)
                return Effect.isEffect(work)
                  ? work.pipe(Effect.as(value.turnId))
                  : Effect.succeed(value.turnId)
              }),
          },
          discoveryDeadline
        )
      ),
    finish: (
      id: string,
      status: "done" | "failed" | "cancelled",
      error: string | null
    ) => run(service.finish(id, status, error)),
    cancelPendingRun: (id: string) => run(service.cancelPendingRun(id)),
    canRun: (id: string) => run(service.canRun(id)),
    nextWake: () => run(service.nextWake()),
  }
}

export function webhookFixture(
  db: Sqlite,
  routines: ReturnType<typeof routineFixture>,
  active: () => boolean
) {
  const service = makeWebhooks(
    new SqliteWebhookPersistence(db),
    routines.admissionState,
    () => Effect.sync(active)
  )
  return {
    service,
    info: (id: string) => run(service.info(id)),
    configure: (input: WebhookConfiguration) => run(service.configure(input)),
    cancel: (id: string) => run(service.cancel(id)),
    authorized: (id: string, hash: string) => run(service.authorized(id, hash)),
    accept: (
      id: string,
      hash: string,
      eventId: string,
      payload: string,
      payloadHash: string
    ) =>
      run(
        service.accept(
          id,
          hash,
          eventId,
          payload,
          payloadHash,
          Date.now() + 60_000
        )
      ),
  }
}

export const fixtureClock = (now: () => number): Clock.Clock => ({
  currentTimeMillisUnsafe: now,
  currentTimeMillis: Effect.sync(now),
  currentTimeNanosUnsafe: () => BigInt(now()) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(now()) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => BigInt(now()) * 1_000_000n,
  monotonicTimeNanos: Effect.sync(() => BigInt(now()) * 1_000_000n),
  sleep: () =>
    Effect.die(
      "This fixture does not support sleeps; use TestClock for timed concurrency."
    ),
})
