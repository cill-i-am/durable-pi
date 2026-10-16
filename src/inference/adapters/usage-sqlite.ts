import { and, count, desc, eq, isNotNull, sum } from "drizzle-orm"
import { Effect, Schema } from "effect"

import { jsonField } from "../../storage/expressions"
import {
  mapSqliteError,
  type Sqlite,
  type EffectSqliteDatabase,
} from "../../storage/sqlite"
import {
  AccountUsage,
  Attempt,
  UsageStorageError,
  UsageTotals,
  type UsageReport,
} from "../usage-domain"
import type { UsageLedger } from "../usage-ledger"
import { inferenceAttempts, modelUsage } from "./schema"

const Row = Schema.Struct({ id: Schema.String, payload: Schema.String })
const JsonAttempt = Schema.fromJsonString(Attempt)
const decode = (raw: unknown): Attempt => {
  const row = Schema.decodeUnknownSync(Row)(raw)
  const attempt = Schema.decodeUnknownSync(JsonAttempt)(row.payload)
  if (attempt.id !== row.id)
    throw new Error("Stored inference attempt identity does not match its key.")
  return attempt
}
export class SqliteUsage implements UsageLedger {
  constructor(private readonly db: Sqlite) {}
  private query<TValue, TError, TRequirements>(
    operation: string,
    body: (
      orm: EffectSqliteDatabase
    ) => Effect.Effect<TValue, TError, TRequirements>
  ) {
    return mapSqliteError(
      this.db.use(body),
      () => new UsageStorageError({ operation })
    )
  }
  atomic<TValue, TError, TRequirements>(
    body: () => Effect.Effect<TValue, TError, TRequirements>
  ) {
    return mapSqliteError(
      this.db.transaction(body),
      () => new UsageStorageError({ operation: "commit" })
    )
  }
  insert(attempt: Attempt) {
    return Effect.suspend(() => {
      const payload = Schema.encodeSync(JsonAttempt)(attempt)
      return this.query("start", (orm) =>
        orm.insert(inferenceAttempts).values({ id: attempt.id, payload })
      ).pipe(Effect.asVoid)
    })
  }
  read(id: string) {
    return this.query("read", (orm) =>
      orm.select().from(inferenceAttempts).where(eq(inferenceAttempts.id, id))
    ).pipe(Effect.map((rows) => decode(rows[0])))
  }
  put(attempt: Attempt) {
    return Effect.suspend(() => {
      const payload = Schema.encodeSync(JsonAttempt)(attempt)
      return this.query("update", (orm) =>
        orm
          .update(inferenceAttempts)
          .set({ payload })
          .where(eq(inferenceAttempts.id, attempt.id))
      ).pipe(Effect.asVoid)
    })
  }
  report(report: UsageReport, at: string) {
    return this.query("report", (orm) =>
      orm
        .insert(modelUsage)
        .values({ ...report, date: at })
        .onConflictDoNothing()
        .returning({ id: modelUsage.id })
    ).pipe(Effect.map((rows) => rows.length > 0))
  }
  running() {
    return this.query("recover", (orm) =>
      orm
        .select()
        .from(inferenceAttempts)
        .where(
          eq(
            jsonField<string>(inferenceAttempts.payload, "$.outcome"),
            "running"
          )
        )
    ).pipe(Effect.map((rows) => rows.map(decode)))
  }
  recent() {
    return this.query("recent", (orm) =>
      orm
        .select()
        .from(inferenceAttempts)
        .orderBy(desc(inferenceAttempts.sequence))
        .limit(100)
    ).pipe(Effect.map((rows) => rows.map(decode)))
  }
  totals(turnId: string) {
    const input = jsonField<number>(inferenceAttempts.payload, "$.input")
    const cached = jsonField<number>(inferenceAttempts.payload, "$.cached")
    const output = jsonField<number>(inferenceAttempts.payload, "$.output")
    return this.query("totals", (orm) =>
      orm
        .select({
          modelRequests: count(),
          usageReportedRequests: sum(
            and(isNotNull(input), isNotNull(cached), isNotNull(output))!
          ),
          knownInputTokens: sum(input),
          knownCachedInputTokens: sum(cached),
          knownOutputTokens: sum(output),
        })
        .from(inferenceAttempts)
        .where(
          eq(jsonField<string>(inferenceAttempts.payload, "$.turnId"), turnId)
        )
    ).pipe(
      Effect.map((rows) => {
        const row = rows[0]!
        return Schema.decodeUnknownSync(UsageTotals)({
          modelRequests: row.modelRequests,
          usageReportedRequests: Number(row.usageReportedRequests ?? 0),
          knownInputTokens: Number(row.knownInputTokens ?? 0),
          knownCachedInputTokens: Number(row.knownCachedInputTokens ?? 0),
          knownOutputTokens: Number(row.knownOutputTokens ?? 0),
        })
      })
    )
  }
  accountTotals() {
    return this.query("account totals", (orm) =>
      orm
        .select({
          input: sum(modelUsage.input),
          cached: sum(modelUsage.cached),
          output: sum(modelUsage.output),
          requests: count(),
        })
        .from(modelUsage)
    ).pipe(
      Effect.map((rows) => {
        const row = rows[0]!
        return Schema.decodeUnknownSync(AccountUsage)({
          input: Number(row.input ?? 0),
          cached: Number(row.cached ?? 0),
          output: Number(row.output ?? 0),
          requests: row.requests,
        })
      })
    )
  }
}
