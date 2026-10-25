import { and, asc, count, desc, eq, inArray, notInArray } from "drizzle-orm"
import { Effect, Layer } from "effect"

import {
  mapSqliteError,
  type Sqlite,
  type EffectSqliteDatabase,
} from "../../storage/sqlite"
import {
  RoutinePersistence,
  RoutineStorageError,
  type OperationReceipt,
} from "../persistence"
import {
  readRoutineRecord,
  type RoutineRecord as Routine,
} from "../routine.machine"
import {
  readRoutineRunRecord,
  type RoutineRunRecord as RoutineRun,
} from "../run.machine"
import { routines, routineRuns, routineOperations } from "./schema"

function indexedRun(row: {
  record: string
  status: string
  id: string
  turn_id: string
  routine_id: string
}) {
  const run = readRoutineRunRecord(JSON.parse(row.record))
  if (
    run.status !== row.status ||
    run.id !== row.id ||
    run.turnId !== row.turn_id ||
    run.routineId !== row.routine_id
  )
    throw new Error(
      "Routine run projection conflicts with its durable record; restore compatible data."
    )
  return run
}

type Records = RoutinePersistence["Service"]
export class SqliteRoutinePersistence implements Records {
  readonly transactionGroup: object
  constructor(private readonly db: Sqlite) {
    this.transactionGroup = db
  }
  private query<TValue, TError, TRequirements>(
    body: (
      orm: EffectSqliteDatabase
    ) => Effect.Effect<TValue, TError, TRequirements>
  ) {
    return mapSqliteError(
      this.db.use(body),
      (cause) => new RoutineStorageError({ operation: "query", cause })
    )
  }
  atomic<TValue, TError, TRequirements>(
    body: () => Effect.Effect<TValue, TError, TRequirements>
  ) {
    return mapSqliteError(
      this.db.transaction(body),
      (cause) => new RoutineStorageError({ operation: "transaction", cause })
    )
  }
  list() {
    return this.query((orm) =>
      orm
        .select({ record: routines.record })
        .from(routines)
        .orderBy(desc(routines.sequence))
    ).pipe(
      Effect.map((rows) =>
        rows.map((row) => readRoutineRecord(JSON.parse(row.record)))
      )
    )
  }
  get(id: string) {
    return this.query((orm) =>
      orm
        .select({ record: routines.record })
        .from(routines)
        .where(eq(routines.id, id))
    ).pipe(
      Effect.map((rows) =>
        rows[0] ? readRoutineRecord(JSON.parse(rows[0].record)) : undefined
      )
    )
  }
  runs() {
    return this.query((orm) =>
      orm
        .select()
        .from(routineRuns)
        .orderBy(desc(routineRuns.sequence))
        .limit(200)
    ).pipe(Effect.map((rows) => rows.map(indexedRun)))
  }
  inFlight() {
    return this.query((orm) =>
      orm
        .select()
        .from(routineRuns)
        .where(
          inArray(routineRuns.status, [
            "pending",
            "queued",
            "stopping",
            "unconfirmed",
          ])
        )
        .orderBy(asc(routineRuns.sequence))
        .limit(1)
    ).pipe(Effect.map((rows) => (rows[0] ? indexedRun(rows[0]) : undefined)))
  }
  put(routine: Routine) {
    const record = JSON.stringify(routine)
    return this.query((orm) =>
      orm
        .insert(routines)
        .values({ id: routine.id, record })
        .onConflictDoUpdate({ target: routines.id, set: { record } })
    ).pipe(Effect.as(routine))
  }
  putRun(raw: RoutineRun) {
    return Effect.suspend(() => {
      const run = readRoutineRunRecord(raw),
        record = JSON.stringify(run)
      return this.query((orm) =>
        orm
          .insert(routineRuns)
          .values({
            id: run.id,
            routine_id: run.routineId,
            turn_id: run.turnId,
            status: run.status,
            record,
          })
          .onConflictDoUpdate({
            target: routineRuns.id,
            set: { status: run.status, record },
          })
      ).pipe(Effect.as(run))
    })
  }
  operation(id: string) {
    return this.query((orm) =>
      orm
        .select({
          input: routineOperations.input,
          result: routineOperations.result,
        })
        .from(routineOperations)
        .where(eq(routineOperations.id, id))
    ).pipe(Effect.map((rows) => rows[0]))
  }
  operationCount() {
    return this.query((orm) =>
      orm.select({ n: count() }).from(routineOperations)
    ).pipe(Effect.map((rows) => rows[0]!.n))
  }
  putOperation(id: string, receipt: OperationReceipt) {
    return this.query((orm) =>
      orm.insert(routineOperations).values({ id, ...receipt })
    ).pipe(Effect.asVoid)
  }
  pruneRuns() {
    return this.query((orm) =>
      orm
        .delete(routineRuns)
        .where(
          and(
            notInArray(routineRuns.status, [
              "pending",
              "queued",
              "stopping",
              "unconfirmed",
            ]),
            notInArray(
              routineRuns.id,
              orm
                .select({ id: routineRuns.id })
                .from(routineRuns)
                .orderBy(desc(routineRuns.sequence))
                .limit(200)
            )
          )
        )
    ).pipe(Effect.asVoid)
  }
}
export const sqliteRoutinePersistence = (db: Sqlite) =>
  Layer.succeed(RoutinePersistence, new SqliteRoutinePersistence(db))
