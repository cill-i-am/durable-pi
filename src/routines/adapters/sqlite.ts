import { Layer, Schema } from "effect"
import type { Sqlite } from "../../storage/sqlite"
import { Routine, RoutineRun } from "../contracts"
import {
  RoutinePersistence,
  RoutineStorageError,
  type OperationReceipt,
} from "../persistence"

type Records = RoutinePersistence["Service"]
export class SqliteRoutinePersistence implements Records {
  readonly transactionGroup: object
  private readonly db: Sqlite
  constructor(db: Sqlite) {
    this.transactionGroup = db
    const storage = <TResult>(
      operation: string,
      body: () => TResult
    ): TResult => {
      try {
        return body()
      } catch (cause) {
        throw new RoutineStorageError({ operation, cause })
      }
    }
    this.db = {
      all: (query, ...bindings) =>
        storage("read", () => db.all(query, ...bindings)),
      run: (query, ...bindings) =>
        storage("write", () => db.run(query, ...bindings)),
      transaction: (body) => {
        const failure: { failed: boolean; cause?: unknown } = { failed: false }
        try {
          return db.transaction(() => {
            try {
              return body()
            } catch (cause) {
              failure.failed = true
              failure.cause = cause
              throw cause
            }
          })
        } catch (cause) {
          if (failure.failed && cause === failure.cause) throw cause
          throw new RoutineStorageError({ operation: "transaction", cause })
        }
      },
    }
    this.db.run(
      "CREATE TABLE IF NOT EXISTS routines (id TEXT PRIMARY KEY,record TEXT NOT NULL)"
    )
    this.db.run(
      "CREATE TABLE IF NOT EXISTS routine_runs (id TEXT PRIMARY KEY,routine_id TEXT NOT NULL,turn_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,record TEXT NOT NULL)"
    )
    this.db.run(
      "CREATE TABLE IF NOT EXISTS routine_operations (id TEXT PRIMARY KEY,input TEXT NOT NULL,result TEXT NOT NULL)"
    )
    this.db.run(
      "CREATE INDEX IF NOT EXISTS routine_runs_status ON routine_runs(status)"
    )
  }
  list(): Routine[] {
    return this.db
      .all<{ record: string }>(
        "SELECT record FROM routines ORDER BY rowid DESC"
      )
      .map((row) => Schema.decodeUnknownSync(Routine)(JSON.parse(row.record)))
  }
  get(id: string) {
    const row = this.db.all<{ record: string }>(
      "SELECT record FROM routines WHERE id=?",
      id
    )[0]
    return row
      ? Schema.decodeUnknownSync(Routine)(JSON.parse(row.record))
      : undefined
  }
  runs(): RoutineRun[] {
    return this.db
      .all<{ record: string }>(
        "SELECT record FROM routine_runs ORDER BY rowid DESC LIMIT 200"
      )
      .map((row) =>
        Schema.decodeUnknownSync(RoutineRun)(JSON.parse(row.record))
      )
  }
  inFlight(): RoutineRun | undefined {
    const row = this.db.all<{ record: string }>(
      "SELECT record FROM routine_runs WHERE status IN ('pending','queued') ORDER BY rowid LIMIT 1"
    )[0]
    return row
      ? Schema.decodeUnknownSync(RoutineRun)(JSON.parse(row.record))
      : undefined
  }
  put(routine: Routine) {
    this.db.run(
      "INSERT INTO routines VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record",
      routine.id,
      JSON.stringify(routine)
    )
    return routine
  }
  putRun(raw: RoutineRun) {
    const run = Schema.decodeUnknownSync(RoutineRun)(raw)
    this.db.run(
      "INSERT INTO routine_runs VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,record=excluded.record",
      run.id,
      run.routineId,
      run.turnId,
      run.status,
      JSON.stringify(run)
    )
    return run
  }
  atomic<TResult>(body: () => TResult): TResult {
    return this.db.transaction(body)
  }
  operation(id: string) {
    return this.db.all<OperationReceipt>(
      "SELECT input,result FROM routine_operations WHERE id=?",
      id
    )[0]
  }
  operationCount() {
    return this.db.all<{ n: number }>(
      "SELECT count(*) AS n FROM routine_operations"
    )[0]!.n
  }
  putOperation(id: string, receipt: OperationReceipt) {
    this.db.run(
      "INSERT INTO routine_operations VALUES (?,?,?)",
      id,
      receipt.input,
      receipt.result
    )
  }
  pruneRuns() {
    this.db.run(
      "DELETE FROM routine_runs WHERE status NOT IN ('pending','queued') AND id NOT IN (SELECT id FROM routine_runs ORDER BY rowid DESC LIMIT 200)"
    )
  }
}
export const sqliteRoutinePersistence = (db: Sqlite) =>
  Layer.sync(RoutinePersistence, () => new SqliteRoutinePersistence(db))
