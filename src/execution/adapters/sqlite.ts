import { count, desc, eq, ne, or } from "drizzle-orm"
import { Effect, Schema } from "effect"

import { jsonField } from "../../storage/expressions"
import {
  mapSqliteError,
  type Sqlite,
  type EffectSqliteDatabase,
} from "../../storage/sqlite"
import { ExecutionStorageError, RunSummary } from "../contracts"
import type { ExecutionLedger } from "../ledger"
import { ExecutionRecord, restoreExecutionRecord } from "../run.machine"
import { codeRuns } from "./schema"

const decode = (row: { record: string }) =>
  restoreExecutionRecord(JSON.parse(row.record))
export class ExecutionStore implements ExecutionLedger {
  constructor(private readonly db: Sqlite) {}
  private query<TValue, TError, TRequirements>(
    body: (
      orm: EffectSqliteDatabase
    ) => Effect.Effect<TValue, TError, TRequirements>
  ) {
    return mapSqliteError(this.db.use(body), () => new ExecutionStorageError())
  }
  atomic<TValue, TError, TRequirements>(
    body: () => Effect.Effect<TValue, TError, TRequirements>
  ) {
    return mapSqliteError(
      this.db.transaction(body),
      () => new ExecutionStorageError()
    )
  }
  get(id: string) {
    return this.query((orm) =>
      orm
        .select({ record: codeRuns.record })
        .from(codeRuns)
        .where(eq(codeRuns.id, id))
    ).pipe(Effect.map((rows) => (rows[0] ? decode(rows[0]) : undefined)))
  }
  list() {
    return this.query((orm) =>
      orm
        .select({ record: codeRuns.record })
        .from(codeRuns)
        .orderBy(desc(codeRuns.created), desc(codeRuns.id))
        .limit(50)
    ).pipe(
      Effect.map((rows) =>
        rows.map((row) => Schema.decodeUnknownSync(RunSummary)(decode(row)))
      )
    )
  }
  counts() {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const totals = yield* this.query((orm) =>
          orm.select({ n: count() }).from(codeRuns)
        )
        const running = yield* this.query((orm) =>
          orm
            .select({ n: count() })
            .from(codeRuns)
            .where(
              or(
                eq(jsonField<string>(codeRuns.record, "$.status"), "running"),
                ne(
                  jsonField<string>(codeRuns.record, "$.occupancy.state"),
                  "free"
                )
              )
            )
        )
        return { total: totals[0]!.n, running: running[0]!.n }
      })
    )
  }
  running() {
    return this.query((orm) =>
      orm
        .select({ record: codeRuns.record })
        .from(codeRuns)
        .where(
          or(
            eq(jsonField<string>(codeRuns.record, "$.status"), "running"),
            ne(jsonField<string>(codeRuns.record, "$.occupancy.state"), "free")
          )
        )
    ).pipe(Effect.map((rows) => rows.map(decode)))
  }
  put(run: ExecutionRecord) {
    return Effect.suspend(() => {
      const record = Schema.encodeSync(Schema.fromJsonString(ExecutionRecord))(
        run
      )
      return this.query((orm) =>
        orm
          .insert(codeRuns)
          .values({ id: run.id, created: run.createdAt, record })
          .onConflictDoUpdate({ target: codeRuns.id, set: { record } })
      ).pipe(Effect.asVoid)
    })
  }
}
