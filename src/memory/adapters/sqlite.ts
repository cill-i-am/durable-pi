import {
  and,
  asc,
  count as countRows,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  isNull,
  inArray,
  lt,
  lte,
  max,
  or,
  sql,
} from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"
import { Effect, Layer, Schema } from "effect"

import { MessageProvenance } from "../../messages/identity"
import {
  containsText,
  divide,
  increment,
  multiply,
  remainder,
} from "../../storage/expressions"
import {
  mapSqliteError,
  type Sqlite,
  type SqliteOrm,
} from "../../storage/sqlite"
import {
  nodeKey,
  byteLength,
  NonNegativeInteger,
  LogKind,
  VIEW_BYTES,
  InvalidMemory,
  MemoryNotReady,
  MemoryStorageError,
  LogEntry,
  type MemoryNode,
  type Part,
} from "../domain"
import { MemoryTransaction, type MemoryLedger } from "../ledger"
import * as Policy from "../policy"
import {
  type ArchiveRecord,
  type Watermark,
  StoredViewState,
  StoredPart,
  StoredNode,
  StoredFailure,
  StoredMerge,
  StoredNote,
  StoredIssue,
  StoredArchiveRecord,
} from "../records"
import { makeMemoryRepository, memoryApplication } from "../service"
import * as t from "./schema"

// Two columns per row/range: 32 keeps every batch below workerd's 100 binds.
const SQL_BATCH_ROWS = 32
const ORIGINAL_READ_ROWS = 8
const PendingMetadata = Schema.Struct({
  id: NonNegativeInteger,
  kind: LogKind,
  bytes: NonNegativeInteger,
})
const PendingText = Schema.Struct({
  id: NonNegativeInteger,
  hex: Schema.String,
})
const decodeOriginal = (hex: string) =>
  new TextDecoder("utf-8", { ignoreBOM: true }).decode(
    Uint8Array.from({ length: hex.length / 2 }, (_, index) =>
      Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
    )
  )

const ProvenanceJson = Schema.fromJsonString(MessageProvenance)
const decodeProvenance = (row: unknown) => {
  if (typeof row !== "object" || row === null || !("provenance" in row))
    return row
  return {
    ...row,
    provenance:
      row.provenance == null
        ? undefined
        : Schema.decodeUnknownSync(ProvenanceJson)(row.provenance),
  }
}
const sameProvenance = (a?: MessageProvenance, b?: MessageProvenance) =>
  (a ? Schema.encodeSync(ProvenanceJson)(a) : undefined) ===
  (b ? Schema.encodeSync(ProvenanceJson)(b) : undefined)

const attempt = <TValue>(body: () => TValue) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      const known = Schema.decodeUnknownOption(
        Schema.Union([InvalidMemory, MemoryNotReady, MemoryStorageError])
      )(cause)
      if (known._tag === "Some") return known.value
      throw cause
    },
  })
const key = (part: Part) =>
  and(eq(t.memoryNodes.start, part.start), eq(t.memoryNodes.count, part.count))
const failureKey = (part: Part) =>
  and(
    eq(t.memoryFailures.start, part.start),
    eq(t.memoryFailures.count, part.count)
  )

class SqliteMemory implements MemoryLedger {
  readonly transactionGroup: object
  constructor(
    readonly db: Sqlite,
    readonly budget = VIEW_BYTES
  ) {
    this.transactionGroup = db
  }
  private query<TValue, TError, TRequirements>(
    body: (orm: SqliteOrm) => Effect.Effect<TValue, TError, TRequirements>
  ) {
    return mapSqliteError(
      this.db.use(body),
      () => new MemoryStorageError({ operation: "query" })
    )
  }
  atomic<TValue, TError, TRequirements>(
    body: () => Effect.Effect<TValue, TError, TRequirements>
  ) {
    return mapSqliteError(
      this.db.transaction(body),
      () => new MemoryStorageError({ operation: "transaction" })
    )
  }
  private rows<TValue, TError, TRequirements, T>(
    schema: Schema.ConstraintDecoder<T, never>,
    body: (orm: SqliteOrm) => Effect.Effect<TValue[], TError, TRequirements>
  ) {
    return this.query(body).pipe(
      Effect.map((rows) =>
        rows.map((row) =>
          Schema.decodeUnknownSync(schema)(decodeProvenance(row))
        )
      )
    )
  }
  initialize() {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        yield* this.query((orm) =>
          orm
            .insert(t.memoryViewState)
            .values({ id: 1, compacting: 0 })
            .onConflictDoNothing()
        )
        const applied = yield* this.query((orm) =>
          orm
            .select()
            .from(t.memoryMigrations)
            .where(eq(t.memoryMigrations.name, "effect-memory-v1"))
            .limit(1)
        )
        if (applied.length) return
        yield* this.readyLeaves()
        yield* this.readyParents()
        const view = yield* this.query((orm) => orm.select().from(t.memoryView))
        for (let offset = 0; offset < view.length; offset += SQL_BATCH_ROWS)
          yield* this.query((orm) =>
            orm
              .insert(t.memoryCompactionView)
              .values(view.slice(offset, offset + SQL_BATCH_ROWS))
          )
        yield* this.query((orm) =>
          orm
            .insert(t.memoryViewState)
            .values({ id: 2, compacting: 1 })
            .onConflictDoNothing()
        )
        yield* this.query((orm) =>
          orm.insert(t.memoryMigrations).values({ name: "effect-memory-v1" })
        )
      })
    )
  }
  private readyLeaves() {
    return Effect.gen({ self: this }, function* () {
      const missing = yield* this.query((orm) =>
        orm
          .select({ start: t.memoryLog.id })
          .from(t.memoryLog)
          .leftJoin(
            t.memoryNodes,
            and(
              eq(t.memoryNodes.start, t.memoryLog.id),
              eq(t.memoryNodes.count, 1)
            )
          )
          .where(isNull(t.memoryNodes.start))
      )
      for (let offset = 0; offset < missing.length; offset += SQL_BATCH_ROWS)
        yield* this.query((orm) =>
          orm
            .insert(t.memoryReady)
            .values(
              missing
                .slice(offset, offset + SQL_BATCH_ROWS)
                .map((row) => ({ start: row.start, count: 1 }))
            )
            .onConflictDoNothing()
        )
    })
  }
  private rebuildReady() {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        yield* this.query((orm) => orm.delete(t.memoryReady))
        const missing = yield* this.query((orm) =>
          orm
            .select({ start: t.memoryLog.id })
            .from(t.memoryLog)
            .leftJoin(
              t.memoryNodes,
              and(
                eq(t.memoryNodes.start, t.memoryLog.id),
                eq(t.memoryNodes.count, 1)
              )
            )
            .where(isNull(t.memoryNodes.start))
        )
        for (let offset = 0; offset < missing.length; offset += SQL_BATCH_ROWS)
          yield* this.query((orm) =>
            orm
              .insert(t.memoryReady)
              .values(
                missing
                  .slice(offset, offset + SQL_BATCH_ROWS)
                  .map((row) => ({ start: row.start, count: 1 }))
              )
              .onConflictDoNothing()
          )
        yield* this.readyParents()
      })
    )
  }
  private readyParents() {
    return Effect.gen({ self: this }, function* () {
      const a = alias(t.memoryNodes, "ready_left"),
        b = alias(t.memoryNodes, "ready_right"),
        p = alias(t.memoryNodes, "ready_parent")
      const candidates = yield* this.query((orm) =>
        orm
          .select({ start: a.start, count: multiply(a.count, 2) })
          .from(a)
          .innerJoin(
            b,
            and(eq(b.start, increment(a.start, a.count)), eq(b.count, a.count))
          )
          .leftJoin(
            p,
            and(eq(p.start, a.start), eq(p.count, multiply(a.count, 2)))
          )
          .where(
            and(
              eq(remainder(a.start, multiply(a.count, 2)), 0),
              isNull(p.start)
            )
          )
      )
      for (let offset = 0; offset < candidates.length; offset += SQL_BATCH_ROWS)
        yield* this.query((orm) =>
          orm
            .insert(t.memoryReady)
            .values(candidates.slice(offset, offset + SQL_BATCH_ROWS))
            .onConflictDoNothing()
        )
    })
  }
  append(
    source: string,
    kind: LogKind,
    text: string,
    date: string,
    provenance?: MessageProvenance
  ): ReturnType<MemoryLedger["append"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const prior = yield* this.rows(LogEntry, (orm) =>
          orm
            .select()
            .from(t.memoryLog)
            .where(eq(t.memoryLog.source, source))
            .limit(1)
        )
        if (prior[0]) {
          if (!sameProvenance(prior[0].provenance, provenance))
            return yield* new InvalidMemory({
              message: "The archived message has different authorship.",
            })
          return prior[0]
        }
        const id = yield* this.total(),
          entry = Schema.decodeUnknownSync(LogEntry)({
            id,
            source,
            kind,
            text,
            date,
            provenance,
          })
        yield* this.query((orm) =>
          orm.insert(t.memoryLog).values({
            ...entry,
            provenance: provenance
              ? Schema.encodeSync(ProvenanceJson)(provenance)
              : null,
          })
        )
        yield* this.query((orm) =>
          orm.insert(t.memoryView).values({ start: id, count: 1 })
        )
        yield* this.query((orm) =>
          orm.insert(t.memoryCompactionView).values({ start: id, count: 1 })
        )
        yield* this.query((orm) =>
          orm.insert(t.memoryReady).values({ start: id, count: 1 })
        )
        yield* this.fitViews()
        return entry
      })
    )
  }
  total(): ReturnType<MemoryLedger["total"]> {
    return this.query((orm) =>
      orm.select({ n: max(t.memoryLog.id) }).from(t.memoryLog)
    ).pipe(Effect.map((rows) => (rows[0]?.n ?? -1) + 1))
  }
  parts(): ReturnType<MemoryLedger["parts"]> {
    return this.rows(StoredPart, (orm) =>
      orm.select().from(t.memoryView).orderBy(asc(t.memoryView.start))
    )
  }
  node(part: Part): ReturnType<MemoryLedger["node"]> {
    return this.rows(StoredNode, (orm) =>
      orm.select().from(t.memoryNodes).where(key(part)).limit(1)
    ).pipe(Effect.map((rows) => rows[0]))
  }
  nodeCount(): ReturnType<MemoryLedger["nodeCount"]> {
    return this.query((orm) =>
      orm.select({ n: countRows() }).from(t.memoryNodes)
    ).pipe(Effect.map((rows) => rows[0]!.n))
  }
  private viewNodes(
    table: typeof t.memoryView | typeof t.memoryCompactionView = t.memoryView
  ) {
    return this.rows(StoredNode, (orm) =>
      orm
        .select(getTableColumns(t.memoryNodes))
        .from(table)
        .innerJoin(
          t.memoryNodes,
          and(
            eq(t.memoryNodes.start, table.start),
            eq(t.memoryNodes.count, table.count)
          )
        )
        .orderBy(asc(table.start))
    )
  }
  entry(id: number): ReturnType<MemoryLedger["entry"]> {
    return this.rows(LogEntry, (orm) =>
      orm.select().from(t.memoryLog).where(eq(t.memoryLog.id, id)).limit(1)
    ).pipe(Effect.map((rows) => rows[0]))
  }
  private fitViews() {
    return Effect.gen({ self: this }, function* () {
      const changed = yield* this.fit(t.memoryView, 1, this.budget)
      if (changed) {
        yield* this.query((orm) => orm.delete(t.memoryCompactionView))
        const view = yield* this.query((orm) => orm.select().from(t.memoryView))
        for (let offset = 0; offset < view.length; offset += SQL_BATCH_ROWS)
          yield* this.query((orm) =>
            orm
              .insert(t.memoryCompactionView)
              .values(view.slice(offset, offset + SQL_BATCH_ROWS))
          )
        yield* this.query((orm) =>
          orm
            .update(t.memoryViewState)
            .set({ compacting: 1 })
            .where(eq(t.memoryViewState.id, 2))
        )
      }
      yield* this.fit(t.memoryCompactionView, 2, this.budget / 4)
    })
  }
  private fit(
    table: typeof t.memoryView | typeof t.memoryCompactionView,
    stateId: number,
    budget: number
  ) {
    return Effect.gen({ self: this }, function* () {
      const parts = yield* this.rows(StoredPart, (orm) =>
          orm.select().from(table).orderBy(asc(table.start))
        ),
        total = yield* this.total(),
        nodes = new Map<string, MemoryNode>()
      for (const node of yield* this.viewNodes(table))
        nodes.set(nodeKey(node), node)
      const state = yield* this.rows(StoredViewState, (orm) =>
        orm
          .select({ compacting: t.memoryViewState.compacting })
          .from(t.memoryViewState)
          .where(eq(t.memoryViewState.id, stateId))
          .limit(1)
      )
      if (
        !Policy.shouldFitMemory(
          parts,
          nodes,
          state[0]!.compacting === 1,
          budget
        )
      )
        return false
      const wanted = Policy.memoryAncestors(parts, total).filter(
        (part) => !nodes.has(nodeKey(part))
      )
      for (let offset = 0; offset < wanted.length; offset += SQL_BATCH_ROWS) {
        const found = yield* this.rows(StoredNode, (orm) =>
          orm
            .select()
            .from(t.memoryNodes)
            .where(
              or(...wanted.slice(offset, offset + SQL_BATCH_ROWS).map(key))
            )
        )
        for (const node of found) nodes.set(nodeKey(node), node)
      }
      const plan = yield* Policy.fitMemory(parts, total, nodes, budget)
      yield* this.query((orm) =>
        orm
          .update(t.memoryViewState)
          .set({ compacting: plan.compacting ? 1 : 0 })
          .where(eq(t.memoryViewState.id, stateId))
      )
      if (!plan.changed) return false
      yield* this.query((orm) => orm.delete(table))
      for (let offset = 0; offset < plan.view.length; offset += SQL_BATCH_ROWS)
        yield* this.query((orm) =>
          orm
            .insert(table)
            .values(plan.view.slice(offset, offset + SQL_BATCH_ROWS))
        )
      return true
    })
  }
  saveNode(part: Part, text: string): ReturnType<MemoryLedger["saveNode"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const total = yield* this.total(),
          plan = yield* attempt(() => Policy.summarySavePlan(part, text, total))
        const children = yield* Effect.forEach(plan.children, (child) =>
          this.node(child)
        )
        yield* attempt(() => Policy.requireSummaryChildren(children))
        yield* this.query((orm) =>
          orm
            .insert(t.memoryNodes)
            .values({ ...part, text, bytes: plan.bytes })
            .onConflictDoNothing()
        )
        yield* this.query((orm) =>
          orm
            .delete(t.memoryReady)
            .where(
              and(
                eq(t.memoryReady.start, part.start),
                eq(t.memoryReady.count, part.count)
              )
            )
        )
        const parent = yield* this.node(plan.parent),
          siblings = yield* Effect.forEach(
            Policy.summaryChildren(plan.parent),
            (child) => this.node(child)
          )
        if (Policy.parentReady(!!parent, siblings))
          yield* this.query((orm) =>
            orm.insert(t.memoryReady).values(plan.parent).onConflictDoNothing()
          )
        yield* this.fitViews()
        yield* this.query((orm) =>
          orm.delete(t.memoryFailures).where(failureKey(part))
        )
      })
    ).pipe(Effect.asVoid)
  }
  private failure(part: Part) {
    return this.rows(StoredFailure, (orm) =>
      orm.select().from(t.memoryFailures).where(failureKey(part)).limit(1)
    ).pipe(Effect.map((rows) => rows[0]))
  }
  failNode(part: Part, retryAt: number): ReturnType<MemoryLedger["failNode"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const before = yield* this.failure(part),
          plan = Policy.summaryFailure(before?.attempts, retryAt)
        yield* this.query((orm) =>
          orm
            .insert(t.memoryFailures)
            .values({
              ...part,
              retry_at: plan.retryAt,
              attempts: plan.attempts,
            })
            .onConflictDoUpdate({
              target: [t.memoryFailures.start, t.memoryFailures.count],
              set: { retry_at: plan.retryAt, attempts: plan.attempts },
            })
        )
        return plan.first
      })
    )
  }
  retryAt(): ReturnType<MemoryLedger["retryAt"]> {
    return this.rows(StoredFailure, (orm) =>
      orm
        .select()
        .from(t.memoryFailures)
        .where(lt(t.memoryFailures.attempts, Policy.SUMMARY_FAILURES))
        .orderBy(asc(t.memoryFailures.retry_at))
        .limit(1)
    ).pipe(Effect.map((rows) => rows[0]?.retry_at))
  }
  issues(): ReturnType<MemoryLedger["issues"]> {
    return this.query((orm) =>
      orm
        .select()
        .from(t.memoryFailures)
        .orderBy(asc(t.memoryFailures.start), asc(t.memoryFailures.count))
        .limit(100)
    ).pipe(
      Effect.map((rows) =>
        rows.map((row) =>
          Schema.decodeUnknownSync(StoredIssue)({
            ...row,
            retryAt:
              row.attempts < Policy.SUMMARY_FAILURES ? row.retry_at : null,
          })
        )
      )
    )
  }
  paused(part: Part): ReturnType<MemoryLedger["paused"]> {
    return this.failure(part).pipe(
      Effect.map((row) => (row?.attempts ?? 0) >= Policy.SUMMARY_FAILURES)
    )
  }
  retrySummary(part: Part): ReturnType<MemoryLedger["retrySummary"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        if (!(yield* this.paused(part))) return false
        yield* this.query((orm) =>
          orm.delete(t.memoryFailures).where(failureKey(part))
        )
        return true
      })
    )
  }
  next(busy: Set<string>, now: number): ReturnType<MemoryLedger["next"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const view = yield* this.viewNodes(t.memoryCompactionView)
        const missing = yield* this.query((orm) =>
          orm
            .select({ start: t.memoryView.start })
            .from(t.memoryView)
            .leftJoin(
              t.memoryNodes,
              and(
                eq(t.memoryNodes.start, t.memoryView.start),
                eq(t.memoryNodes.count, t.memoryView.count)
              )
            )
            .where(isNull(t.memoryNodes.start))
            .orderBy(asc(t.memoryView.start))
            .limit(1)
        )
        const first = missing[0]?.start ?? (yield* this.total())
        const eligible = or(
          isNull(t.memoryFailures.start),
          and(
            lt(t.memoryFailures.attempts, Policy.SUMMARY_FAILURES),
            lte(t.memoryFailures.retry_at, now)
          )
        )
        const leaves = yield* this.rows(LogEntry, (orm) =>
          orm
            .select(getTableColumns(t.memoryLog))
            .from(t.memoryReady)
            .innerJoin(t.memoryLog, eq(t.memoryLog.id, t.memoryReady.start))
            .leftJoin(
              t.memoryFailures,
              and(
                eq(t.memoryFailures.start, t.memoryReady.start),
                eq(t.memoryFailures.count, t.memoryReady.count)
              )
            )
            .where(
              and(
                eq(t.memoryReady.count, 1),
                lte(t.memoryReady.start, first),
                eligible
              )
            )
            .orderBy(asc(t.memoryReady.start))
            .limit(1)
        )
        const a = alias(t.memoryNodes, "summary_left"),
          b = alias(t.memoryNodes, "summary_right")
        const parents = yield* this.rows(StoredMerge, (orm) =>
          orm
            .select({
              start: t.memoryReady.start,
              count: t.memoryReady.count,
              left_text: a.text,
              right_text: b.text,
            })
            .from(t.memoryReady)
            .innerJoin(
              a,
              and(
                eq(a.start, t.memoryReady.start),
                eq(a.count, divide(t.memoryReady.count, 2))
              )
            )
            .innerJoin(
              b,
              and(
                eq(
                  b.start,
                  increment(t.memoryReady.start, divide(t.memoryReady.count, 2))
                ),
                eq(b.count, divide(t.memoryReady.count, 2))
              )
            )
            .leftJoin(
              t.memoryFailures,
              and(
                eq(t.memoryFailures.start, t.memoryReady.start),
                eq(t.memoryFailures.count, t.memoryReady.count)
              )
            )
            .where(
              and(
                gt(t.memoryReady.count, 1),
                lte(increment(t.memoryReady.start, t.memoryReady.count), first),
                eligible
              )
            )
            .orderBy(asc(t.memoryReady.count), asc(t.memoryReady.start))
            .limit(busy.size + 1)
        )
        return Policy.summaryJob(leaves, parents, busy, view)
      })
    )
  }
  blocked(): ReturnType<MemoryLedger["blocked"]> {
    return this.query((orm) =>
      orm
        .select({ start: t.memoryFailures.start })
        .from(t.memoryView)
        .innerJoin(
          t.memoryFailures,
          and(
            eq(t.memoryFailures.start, t.memoryView.start),
            eq(t.memoryFailures.count, t.memoryView.count)
          )
        )
        .leftJoin(
          t.memoryNodes,
          and(
            eq(t.memoryNodes.start, t.memoryView.start),
            eq(t.memoryNodes.count, t.memoryView.count)
          )
        )
        .where(
          and(
            gte(t.memoryFailures.attempts, Policy.SUMMARY_FAILURES),
            isNull(t.memoryNodes.start)
          )
        )
        .limit(1)
    ).pipe(Effect.map((rows) => rows.length > 0))
  }
  settled(): ReturnType<MemoryLedger["settled"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        return (yield* this.parts()).length === (yield* this.viewNodes()).length
      })
    )
  }
  render(): ReturnType<MemoryLedger["render"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const parts = yield* this.parts()
        const nodes = new Map(
          (yield* this.viewNodes()).map((node) => [nodeKey(node), node])
        )
        const metadata =
          parts.length === nodes.size
            ? []
            : yield* this.rows(PendingMetadata, (orm) =>
                orm
                  .select({
                    id: t.memoryLog.id,
                    kind: t.memoryLog.kind,
                    bytes: sql<number>`length(cast(${t.memoryLog.text} as blob))`,
                  })
                  .from(t.memoryView)
                  .leftJoin(
                    t.memoryNodes,
                    and(
                      eq(t.memoryNodes.start, t.memoryView.start),
                      eq(t.memoryNodes.count, t.memoryView.count)
                    )
                  )
                  .innerJoin(
                    t.memoryLog,
                    and(
                      eq(t.memoryLog.id, t.memoryView.start),
                      eq(t.memoryView.count, 1)
                    )
                  )
                  .where(isNull(t.memoryNodes.start))
                  .orderBy(desc(t.memoryLog.id))
              )
        const originals = new Map<number, LogEntry>()
        const omitted = new Map<number, boolean>()
        const texts = new Map<number, string>()
        let available = Policy.pendingOriginalAllowance(parts, nodes)
        for (let index = 0; index < metadata.length; index++) {
          const row = metadata[index]!
          if (available < 128) {
            omitted.set(
              row.id,
              row.bytes + byteLength(`${row.id}+0|${row.kind}: `) > available
            )
            continue
          }
          if (!texts.has(row.id)) {
            const ids = metadata
              .slice(index, index + ORIGINAL_READ_ROWS)
              .map((entry) => entry.id)
            // Slice bytes, not SQLite text (whose length/substr stop at NUL).
            // Hex transports split UTF-8 safely. Any replacement at the joined
            // middle lies outside the smaller head/tail selected by the policy.
            const rows = yield* this.rows(PendingText, (orm) =>
              orm
                .select({
                  id: t.memoryLog.id,
                  hex: sql<string>`hex(case when length(cast(${t.memoryLog.text} as blob)) > 8192 then substr(cast(${t.memoryLog.text} as blob),1,4096) || substr(cast(${t.memoryLog.text} as blob),-4096) else cast(${t.memoryLog.text} as blob) end)`,
                })
                .from(t.memoryLog)
                .where(inArray(t.memoryLog.id, ids))
            )
            for (const entry of rows)
              texts.set(entry.id, decodeOriginal(entry.hex))
          }
          const text = texts.get(row.id)
          if (text === undefined)
            return yield* Effect.die(
              new Error("Memory lost a committed working-context original")
            )
          const entry = {
            id: row.id,
            kind: row.kind,
            text,
            source: "",
            date: "",
          }
          originals.set(row.id, entry)
          const selected = Policy.pendingOriginalLine(entry, available)
          if (selected.rendered !== undefined)
            available -= byteLength(selected.rendered) + 1
        }
        return Policy.renderMemory(parts, nodes, originals, omitted)
      })
    )
  }
  zoom(start: number, count: number): ReturnType<MemoryLedger["zoom"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const part = { start, count },
          total = yield* this.total()
        yield* attempt(() => Policy.requireMemoryRange(part, total))
        const entry = count === 1 ? yield* this.entry(start) : undefined,
          children = yield* Effect.forEach(
            Policy.summaryChildren(part),
            (child) => this.node(child)
          )
        return yield* attempt(() => Policy.zoomMemory(part, entry, children))
      })
    )
  }
  search(query: string): ReturnType<MemoryLedger["search"]> {
    return this.rows(LogEntry, (orm) =>
      orm
        .select()
        .from(t.memoryLog)
        .where(containsText(t.memoryLog.text, query))
        .orderBy(desc(t.memoryLog.id))
        .limit(30)
    )
  }
  notes(): ReturnType<MemoryLedger["notes"]> {
    return this.rows(StoredNote, (orm) =>
      orm.select().from(t.memoryNotes).orderBy(asc(t.memoryNotes.path))
    )
  }
  writeNote(
    path: string,
    body: string,
    sourceId: number,
    date: string
  ): ReturnType<MemoryLedger["writeNote"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        yield* attempt(() => Policy.requireMemoryNote(path, body, true))
        const entry = yield* this.entry(sourceId)
        yield* attempt(() => Policy.requireMemoryNote(path, body, !!entry))
        yield* this.query((orm) =>
          orm
            .insert(t.memoryNoteHistory)
            .values({ path, body, source_id: sourceId, date })
        )
        yield* this.query((orm) =>
          orm
            .insert(t.memoryNotes)
            .values({ path, body, source_id: sourceId, updated_at: date })
            .onConflictDoUpdate({
              target: t.memoryNotes.path,
              set: { body, source_id: sourceId, updated_at: date },
            })
        )
      })
    ).pipe(Effect.asVoid)
  }
  watermark(): ReturnType<MemoryLedger["watermark"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const messages = yield* this.total(),
          nodes = yield* this.query((orm) =>
            orm.select({ n: max(t.memoryNodes.sequence) }).from(t.memoryNodes)
          ),
          notes = yield* this.query((orm) =>
            orm
              .select({ n: max(t.memoryNoteHistory.id) })
              .from(t.memoryNoteHistory)
          )
        return {
          messages,
          nodes: Number(nodes[0]?.n ?? 0),
          notes: notes[0]?.n ?? 0,
        }
      })
    )
  }
  archivePage(
    after: Watermark,
    until: Watermark,
    limit = 32
  ): ReturnType<MemoryLedger["archivePage"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const messages = yield* this.query((orm) =>
          orm
            .select()
            .from(t.memoryLog)
            .where(
              and(
                gte(t.memoryLog.id, after.messages),
                lt(t.memoryLog.id, until.messages)
              )
            )
            .orderBy(asc(t.memoryLog.id))
            .limit(limit)
        )
        const nodes = yield* this.query((orm) =>
          orm
            .select({
              seq: t.memoryNodes.sequence,
              start: t.memoryNodes.start,
              count: t.memoryNodes.count,
              text: t.memoryNodes.text,
              bytes: t.memoryNodes.bytes,
            })
            .from(t.memoryNodes)
            .where(
              and(
                gt(t.memoryNodes.sequence, after.nodes),
                lte(t.memoryNodes.sequence, until.nodes)
              )
            )
            .orderBy(asc(t.memoryNodes.sequence))
            .limit(limit - messages.length)
        )
        const notes = yield* this.query((orm) =>
          orm
            .select()
            .from(t.memoryNoteHistory)
            .where(
              and(
                gt(t.memoryNoteHistory.id, after.notes),
                lte(t.memoryNoteHistory.id, until.notes)
              )
            )
            .orderBy(asc(t.memoryNoteHistory.id))
            .limit(limit - messages.length - nodes.length)
        )
        return [
          ...messages.map((row) => ({ ...row, type: "message" })),
          ...nodes.map((row) => ({ ...row, type: "node" })),
          ...notes.map((row) => ({ ...row, type: "note" })),
        ].map((row) =>
          Schema.decodeUnknownSync(StoredArchiveRecord)(decodeProvenance(row))
        )
      })
    )
  }
  restore(
    records: readonly ArchiveRecord[],
    parts: readonly Part[]
  ): ReturnType<MemoryLedger["restore"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        if (
          (yield* this.total()) ||
          (yield* this.nodeCount()) ||
          (yield* this.notes()).length
        )
          return yield* new InvalidMemory({
            message: "Restore requires an empty memory store",
          })
        const plan = yield* attempt(() =>
          Policy.memoryRestorePlan(records, parts)
        )
        for (const record of plan.messages)
          yield* this.append(
            record.source,
            record.kind,
            record.text,
            record.date,
            record.provenance
          )
        for (const record of plan.nodes)
          yield* this.query((orm) =>
            orm.insert(t.memoryNodes).values({
              sequence: record.seq,
              start: record.start,
              count: record.count,
              text: record.text,
              bytes: record.bytes,
            })
          )
        for (const record of plan.notes) {
          const entry = yield* this.entry(record.source_id)
          yield* attempt(() =>
            Policy.requireMemoryNote(record.path, record.body, !!entry)
          )
          yield* this.query((orm) =>
            orm.insert(t.memoryNoteHistory).values({
              id: record.id,
              path: record.path,
              body: record.body,
              source_id: record.source_id,
              date: record.date,
            })
          )
          yield* this.query((orm) =>
            orm
              .insert(t.memoryNotes)
              .values({
                path: record.path,
                body: record.body,
                source_id: record.source_id,
                updated_at: record.date,
              })
              .onConflictDoUpdate({
                target: t.memoryNotes.path,
                set: {
                  body: record.body,
                  source_id: record.source_id,
                  updated_at: record.date,
                },
              })
          )
        }
        yield* this.rebuildReady()
        yield* this.query((orm) => orm.delete(t.memoryCompactionView))
        yield* this.query((orm) => orm.delete(t.memoryView))
        yield* this.query((orm) =>
          orm
            .update(t.memoryViewState)
            .set({ compacting: 0 })
            .where(eq(t.memoryViewState.id, 1))
        )
        yield* this.query((orm) =>
          orm
            .update(t.memoryViewState)
            .set({ compacting: 1 })
            .where(eq(t.memoryViewState.id, 2))
        )
        for (let offset = 0; offset < parts.length; offset += SQL_BATCH_ROWS) {
          yield* this.query((orm) =>
            orm
              .insert(t.memoryCompactionView)
              .values(parts.slice(offset, offset + SQL_BATCH_ROWS))
          )
          yield* this.query((orm) =>
            orm
              .insert(t.memoryView)
              .values(parts.slice(offset, offset + SQL_BATCH_ROWS))
          )
        }
      })
    ).pipe(Effect.asVoid)
  }
  importEntries(
    id: string,
    records: readonly { kind: LogKind; text: string; date: string }[]
  ): ReturnType<MemoryLedger["importEntries"]> {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const before = yield* this.total()
        for (const [i, r] of records.entries())
          yield* this.append(`import:${id}:${i}`, r.kind, r.text, r.date)
        return (yield* this.total()) - before
      })
    )
  }
}

const openSqliteMemory = Effect.fn("Memory.sqlite.open")(function* (
  db: Sqlite,
  budget: number = VIEW_BYTES
) {
  const storage = new SqliteMemory(db, budget)
  yield* storage.initialize()
  return storage
})
export const makeSqliteMemory = (db: Sqlite, budget = VIEW_BYTES) =>
  openSqliteMemory(db, budget).pipe(Effect.map(makeMemoryRepository))
export const sqliteMemoryLayer = (db: Sqlite, budget = VIEW_BYTES) =>
  Layer.unwrap(
    openSqliteMemory(db, budget).pipe(
      Effect.map((ledger) =>
        Layer.mergeAll(
          memoryApplication(ledger),
          Layer.succeed(MemoryTransaction, ledger)
        )
      )
    )
  )
