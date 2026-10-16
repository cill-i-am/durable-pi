import { and, desc, eq, max } from "drizzle-orm"
import { Effect, Schema } from "effect"
import {
  mapSqliteError,
  type Sqlite,
  type SqliteOrm,
} from "../../storage/sqlite"
import { increment } from "../../storage/expressions"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import { ResolvedRoute } from "../../inference/policy"
import {
  InvalidMemory,
  MemoryStorageError,
  NonNegativeInteger,
  Part,
} from "../domain"
import {
  SummaryRouteRecord,
  summaryOperationApplied,
  summaryRequestAllowed,
  summaryBudget,
  requireSummaryRevision,
  type SummaryRouteLedger,
} from "../routing"
import { summaryRoutes } from "./schema"

const attempt = <T>(body: () => T) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      if (cause instanceof InvalidMemory) return cause
      throw cause
    },
  })
export class SummaryRoutes implements SummaryRouteLedger {
  readonly transactionGroup: object
  constructor(private readonly db: Sqlite) {
    this.transactionGroup = db
  }
  private query<T>(
    body: (orm: SqliteOrm) => Effect.Effect<T, EffectDrizzleQueryError>
  ) {
    return mapSqliteError(
      this.db.use(body),
      () => new MemoryStorageError({ operation: "summary route" })
    )
  }
  atomic<T, TError, TRequirements>(
    body: () => Effect.Effect<T, TError, TRequirements>
  ) {
    return mapSqliteError(
      this.db.transaction(body),
      () => new MemoryStorageError({ operation: "summary route transaction" })
    )
  }
  private record(part: Part) {
    return this.query((orm) =>
      orm
        .select()
        .from(summaryRoutes)
        .where(
          and(
            eq(summaryRoutes.start, part.start),
            eq(summaryRoutes.count, part.count)
          )
        )
        .orderBy(desc(summaryRoutes.revision))
        .limit(1)
    ).pipe(
      Effect.map((rows) => {
        const row = rows[0]
        if (!row) return undefined
        const rawRoute = Schema.decodeUnknownSync(
          Schema.Record(Schema.String, Schema.Unknown)
        )(JSON.parse(row.route))
        return {
          ...Schema.decodeUnknownSync(SummaryRouteRecord)({
            ...row,
            route: rawRoute,
          }),
          rawRoute,
        }
      })
    )
  }
  revision(part: Part): ReturnType<SummaryRouteLedger["revision"]> {
    return this.query((orm) =>
      orm
        .select({ revision: max(summaryRoutes.revision) })
        .from(summaryRoutes)
        .where(
          and(
            eq(summaryRoutes.start, part.start),
            eq(summaryRoutes.count, part.count)
          )
        )
    ).pipe(
      Effect.map((rows) =>
        Schema.decodeUnknownSync(NonNegativeInteger)(rows[0]?.revision ?? 0)
      )
    )
  }
  current(part: Part): ReturnType<SummaryRouteLedger["current"]> {
    return this.record(part).pipe(Effect.map((record) => record?.route))
  }
  applied(
    operation: string,
    part: Part
  ): ReturnType<SummaryRouteLedger["applied"]> {
    return this.query((orm) =>
      orm
        .select({ start: summaryRoutes.start, count: summaryRoutes.count })
        .from(summaryRoutes)
        .where(eq(summaryRoutes.operation, operation))
        .limit(1)
    ).pipe(
      Effect.flatMap((rows) =>
        attempt(() =>
          summaryOperationApplied(
            rows[0] ? Schema.decodeUnknownSync(Part)(rows[0]) : undefined,
            part
          )
        )
      )
    )
  }
  pin(
    part: Part,
    candidate: ResolvedRoute
  ): ReturnType<SummaryRouteLedger["pin"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        return (
          (yield* this.current(part)) ??
          (yield* this.replace(part, crypto.randomUUID(), candidate))
        )
      })
    )
  }
  budget(
    part: Part,
    contextWindow: number,
    expectedRevision?: number
  ): ReturnType<SummaryRouteLedger["budget"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const current = yield* this.record(part)
        yield* attempt(() =>
          requireSummaryRevision(current?.revision, expectedRevision)
        )
        const budgeted = yield* attempt(() =>
          summaryBudget(current?.route, contextWindow)
        )
        if (budgeted === current?.route) return budgeted
        yield* this.query((orm) =>
          orm
            .update(summaryRoutes)
            .set({
              route: JSON.stringify({
                ...current!.rawRoute,
                contextWindow: budgeted.contextWindow,
              }),
            })
            .where(
              and(
                eq(summaryRoutes.start, part.start),
                eq(summaryRoutes.count, part.count),
                eq(summaryRoutes.revision, current!.revision)
              )
            )
        )
        return (yield* this.current(part))!
      })
    )
  }
  beginRequest(
    part: Part,
    expectedRevision?: number
  ): ReturnType<SummaryRouteLedger["beginRequest"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const record = yield* this.record(part)
        yield* attempt(() =>
          requireSummaryRevision(record?.revision, expectedRevision)
        )
        if (!summaryRequestAllowed(record)) return false
        yield* this.query((orm) =>
          orm
            .update(summaryRoutes)
            .set({ requests: increment(summaryRoutes.requests) })
            .where(
              and(
                eq(summaryRoutes.start, part.start),
                eq(summaryRoutes.count, part.count),
                eq(summaryRoutes.revision, record!.revision)
              )
            )
        )
        return true
      })
    )
  }
  replace(
    part: Part,
    operation: string,
    candidate: ResolvedRoute
  ): ReturnType<SummaryRouteLedger["replace"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        yield* this.applied(operation, part)
        const prior = yield* this.query((orm) =>
          orm
            .select({ route: summaryRoutes.route })
            .from(summaryRoutes)
            .where(eq(summaryRoutes.operation, operation))
            .limit(1)
        )
        if (prior[0])
          return Schema.decodeUnknownSync(ResolvedRoute)(
            JSON.parse(prior[0].route)
          )
        const revision = (yield* this.revision(part)) + 1
        yield* this.query((orm) =>
          orm.insert(summaryRoutes).values({
            ...part,
            revision,
            operation,
            route: JSON.stringify(candidate),
          })
        )
        return candidate
      })
    )
  }
}
