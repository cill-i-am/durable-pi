import { and, desc, eq, max } from "drizzle-orm"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import { Effect, Schema } from "effect"

import { ResolvedRoute } from "../../inference/policy"
import { increment } from "../../storage/expressions"
import {
  mapSqliteError,
  type Sqlite,
  type SqliteOrm,
} from "../../storage/sqlite"
import {
  InvalidMemory,
  MemoryStorageError,
  NonNegativeInteger,
  Part,
  type SummaryWork,
} from "../domain"
import {
  SummaryRouteRecord,
  summaryOperationApplied,
  summaryRequestAllowed,
  summaryBudget,
  requireSummaryRevision,
  type SummaryRouteLedger,
} from "../routing"
import {
  advanceSummary,
  readSummaryControl,
  ownsSummary,
  type SummaryControl,
} from "../summary.machine"
import { memoryReady, summaryRoutes } from "./schema"

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
  private claimControl(part: SummaryWork, request = false) {
    return Effect.gen({ self: this }, function* () {
      const rows = yield* this.query((orm) =>
        orm
          .select({ control: memoryReady.control })
          .from(memoryReady)
          .where(
            and(
              eq(memoryReady.start, part.start),
              eq(memoryReady.count, part.count)
            )
          )
          .limit(1)
      )
      const control = rows[0]?.control
        ? readSummaryControl(rows[0].control)
        : undefined
      if (part.claim) {
        if (
          !control ||
          part.claim.start !== part.start ||
          part.claim.count !== part.count ||
          !ownsSummary(control, part.claim)
        )
          return yield* new InvalidMemory({
            message: "This summary claim is no longer current.",
          })
      } else if (
        (request && rows.length > 0) ||
        control?.state === "claimed" ||
        control?.state === "paused"
      )
        return yield* new InvalidMemory({
          message: "A current summary claim is required.",
        })
      return control
    })
  }
  private saveClaimControl(part: Part, control: SummaryControl) {
    return this.query((orm) =>
      orm
        .update(memoryReady)
        .set({ control: JSON.stringify(control) })
        .where(
          and(
            eq(memoryReady.start, part.start),
            eq(memoryReady.count, part.count)
          )
        )
    ).pipe(Effect.asVoid)
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
    part: SummaryWork,
    candidate: ResolvedRoute
  ): ReturnType<SummaryRouteLedger["pin"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const control = yield* this.claimControl(part)
        const route =
          (yield* this.current(part)) ??
          (yield* this.replace(part, crypto.randomUUID(), candidate))
        if (part.claim && control) {
          const revision = yield* this.revision(part)
          const next = advanceSummary(control, {
            type: "BIND_ROUTE",
            token: part.claim.token,
            revision: part.claim.revision,
            routeRevision: revision,
          })
          if (next.routeRevision !== revision)
            return yield* new InvalidMemory({
              message: "The summary route changed before request admission.",
            })
          yield* this.saveClaimControl(part, next)
        }
        return route
      })
    )
  }
  budget(
    part: SummaryWork,
    contextWindow: number,
    expectedRevision?: number
  ): ReturnType<SummaryRouteLedger["budget"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const control = yield* this.claimControl(part)
        const current = yield* this.record(part)
        if (part.claim && control?.routeRevision !== current?.revision)
          return yield* new InvalidMemory({
            message: "The summary route changed before request admission.",
          })
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
    part: SummaryWork,
    expectedRevision?: number
  ): ReturnType<SummaryRouteLedger["beginRequest"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const control = yield* this.claimControl(part, true)
        const record = yield* this.record(part)
        yield* attempt(() =>
          requireSummaryRevision(record?.revision, expectedRevision)
        )
        if (!summaryRequestAllowed(record)) return false
        if (part.claim && control) {
          const next = advanceSummary(control, {
            type: "BEGIN_REQUEST",
            token: part.claim.token,
            revision: part.claim.revision,
            routeRevision: record!.revision,
          })
          if (control.requestInFlight || !next.requestInFlight)
            return yield* new InvalidMemory({
              message: "This summary already has an unconfirmed model request.",
            })
          yield* this.saveClaimControl(part, next)
        }
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
  finishRequest(
    part: SummaryWork,
    expectedRevision?: number
  ): ReturnType<SummaryRouteLedger["finishRequest"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const control = yield* this.claimControl(part),
          current = yield* this.revision(part)
        yield* attempt(() => requireSummaryRevision(current, expectedRevision))
        if (!part.claim || !control) return
        if (control.routeRevision !== current)
          return yield* new InvalidMemory({
            message:
              "The summary route changed before request acknowledgement.",
          })
        yield* this.saveClaimControl(
          part,
          advanceSummary(control, {
            type: "FINISH_REQUEST",
            token: part.claim.token,
            revision: part.claim.revision,
            routeRevision: current,
          })
        )
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
