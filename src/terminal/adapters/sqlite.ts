import { count, desc, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"

import {
  mapSqliteError,
  type Sqlite,
  type EffectSqliteDatabase,
} from "../../storage/sqlite"
import {
  advanceCommandRecord,
  newCommandRecord,
  restoreCommandRecord,
  type CommandRecord,
} from "../command.machine"
import {
  TerminalFailure,
  TerminalStorageError,
  type CommandInput,
  CommandRun as CommandRunResult,
  type CommandRun,
  Checkpoint,
  type CommandSummary,
  type TerminalNetworkPolicy,
} from "../contracts"
import * as Domain from "../domain"
import {
  advanceTerminalOccupancy,
  type OccupancyEvent,
} from "../occupancy.machine"
import type { TerminalAuthority, TerminalLedger } from "../repository"
import {
  terminalAuthority,
  terminalCancellations,
  terminalCheckpoint,
  terminalExports,
  terminalNetwork,
  terminalRuns,
} from "./schema"

const decision = <TValue>(body: () => TValue) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      if (cause instanceof TerminalFailure) return cause
      throw cause
    },
  })
const commandResult = Schema.decodeUnknownSync(CommandRunResult)
const decode = (row: { record: string }) =>
  restoreCommandRecord(JSON.parse(row.record))
export class TerminalStore implements TerminalLedger {
  constructor(
    private readonly db: Sqlite,
    private readonly onFinished?: (run: CommandRun) => void,
    private readonly writable?: () => void,
    private readonly cancellationAllowed?: () => void
  ) {}
  private query<TValue, TError, TRequirements>(
    body: (
      orm: EffectSqliteDatabase
    ) => Effect.Effect<TValue, TError, TRequirements>
  ) {
    return mapSqliteError(
      this.db.use(body),
      (cause) => new TerminalStorageError({ operation: "query", cause })
    )
  }
  private atomic<TValue, TError, TRequirements>(
    body: () => Effect.Effect<TValue, TError, TRequirements>
  ) {
    return mapSqliteError(
      this.db.transaction(body),
      (cause) => new TerminalStorageError({ operation: "transaction", cause })
    )
  }
  networkPolicy() {
    return this.query((orm) =>
      orm.select().from(terminalNetwork).where(eq(terminalNetwork.id, 1))
    ).pipe(
      Effect.map((rows) =>
        rows[0]
          ? {
              revision: rows[0].revision,
              unrestricted: rows[0].unrestricted === 1,
            }
          : { revision: 0, unrestricted: true }
      )
    )
  }
  configureNetwork(input: TerminalNetworkPolicy) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        yield* decision(() => this.writable?.())
        if (yield* this.occupied())
          return yield* new TerminalFailure({
            message:
              "Stop or save the active terminal session and wait for cleanup before changing internet access.",
          })
        const current = yield* this.networkPolicy()
        const authority = yield* this.authority()
        const next = yield* decision(() =>
          Domain.networkChange(current, input, authority)
        )
        const values = {
          id: 1,
          revision: next.revision,
          unrestricted: next.unrestricted ? 1 : 0,
        }
        yield* this.query((orm) =>
          orm
            .insert(terminalNetwork)
            .values(values)
            .onConflictDoUpdate({ target: terminalNetwork.id, set: values })
        )
        return yield* this.networkPolicy()
      })
    )
  }
  exported(id: string) {
    return this.query((orm) =>
      orm
        .select({ record: terminalExports.record })
        .from(terminalExports)
        .where(eq(terminalExports.id, id))
    ).pipe(
      Effect.map((rows) =>
        rows[0]
          ? Schema.decodeUnknownSync(Checkpoint)(JSON.parse(rows[0].record))
          : null
      )
    )
  }
  cancelled(id: string) {
    return this.query((orm) =>
      orm
        .select({ id: terminalCancellations.id })
        .from(terminalCancellations)
        .where(eq(terminalCancellations.id, id))
    ).pipe(Effect.map((rows) => rows.length > 0))
  }
  cancel(id: string, committed?: () => void) {
    // The cancellation fence commits before finalization. A failed outcome
    // publication must retain that fence, and observers run after its own commit.
    return this.db.use(() =>
      Effect.gen({ self: this }, function* () {
        yield* this.atomic(() =>
          Effect.gen({ self: this }, function* () {
            yield* decision(() => this.cancellationAllowed?.())
            yield* this.query((orm) =>
              orm
                .insert(terminalCancellations)
                .values({ id })
                .onConflictDoNothing()
            )
          })
        )
        yield* Effect.sync(() => committed?.())
        return (yield* this.get(id))
          ? yield* this.finish(id, {
              status: "cancelled",
              exitCode: null,
              error:
                "Cancelled. Workspace recovery uses the last saved checkpoint.",
            })
          : null
      })
    )
  }
  authority(): Effect.Effect<
    TerminalAuthority | undefined,
    TerminalStorageError
  > {
    return this.query((orm) =>
      orm
        .select({
          revision: terminalAuthority.revision,
          active: terminalAuthority.active,
          revokedThrough: terminalAuthority.revoked_through,
        })
        .from(terminalAuthority)
        .where(eq(terminalAuthority.id, 1))
    ).pipe(Effect.map((rows) => rows[0]))
  }
  configure(
    revision: number,
    active: boolean,
    revokeThrough = active ? -1 : revision,
    committed?: (authority: TerminalAuthority) => void
  ) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        yield* decision(() => this.writable?.())
        const current = yield* this.authority()
        const revokedThrough = Math.max(revokeThrough, active ? -1 : revision)
        const values = {
          id: 1,
          revision: Math.max(current?.revision ?? revision, revision),
          active:
            current && revision <= current.revision
              ? current.active
              : active
                ? 1
                : 0,
          revoked_through: Math.max(
            current?.revokedThrough ?? -1,
            revokedThrough
          ),
        }
        yield* this.query((orm) =>
          orm
            .insert(terminalAuthority)
            .values(values)
            .onConflictDoUpdate({ target: terminalAuthority.id, set: values })
        )
        return {
          revision: values.revision,
          active: values.active,
          revokedThrough: values.revoked_through,
        }
      })
    ).pipe(
      Effect.tap((authority) => Effect.sync(() => committed?.(authority))),
      Effect.asVoid
    )
  }
  authorized(run: CommandRun) {
    return this.authority().pipe(
      Effect.map((authority) => Domain.authorized(run, authority))
    )
  }
  get(id: string) {
    return this.query((orm) =>
      orm
        .select({ record: terminalRuns.record })
        .from(terminalRuns)
        .where(eq(terminalRuns.id, id))
    ).pipe(Effect.map((rows) => (rows[0] ? decode(rows[0]) : undefined)))
  }
  list(): Effect.Effect<CommandSummary[], TerminalStorageError> {
    return this.query((orm) =>
      orm
        .select({ record: terminalRuns.record })
        .from(terminalRuns)
        .orderBy(desc(terminalRuns.created), desc(terminalRuns.id))
        .limit(20)
    ).pipe(
      Effect.map((rows) =>
        rows.map((row) => {
          const run = decode(row)
          return {
            id: run.id,
            label: Array.from(run.command).slice(0, 100).join(""),
            status: run.status,
            createdAt: run.createdAt,
            finishedAt: run.finishedAt,
            savedAt: run.savedAt,
          }
        })
      )
    )
  }
  checkpoint() {
    return this.query((orm) =>
      orm
        .select({ record: terminalCheckpoint.record })
        .from(terminalCheckpoint)
        .where(eq(terminalCheckpoint.id, 1))
    ).pipe(
      Effect.map((rows) =>
        rows[0]
          ? Schema.decodeUnknownSync(Checkpoint)(JSON.parse(rows[0].record))
          : null
      )
    )
  }
  private put(value: CommandRecord) {
    const record = JSON.stringify(value)
    return this.query((orm) =>
      orm
        .insert(terminalRuns)
        .values({ id: value.id, created: value.createdAt, record })
        .onConflictDoUpdate({ target: terminalRuns.id, set: { record } })
    ).pipe(Effect.as(value))
  }
  claim(
    input: CommandInput,
    kind: NonNullable<CommandRun["kind"]>,
    transfer: CommandRun["transfer"],
    attemptId: string
  ) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        yield* decision(() => this.writable?.())
        const stored = yield* this.get(input.id)
        const previous = yield* decision(() =>
          Domain.replayCommand(stored, input, kind, transfer)
        )
        if (previous) return { run: stored!, fresh: false }
        const occupied = yield* this.occupied()
        if (occupied)
          return yield* new TerminalFailure({
            message: "Wait for the active command and its cleanup to finish.",
          })
        const authority = yield* this.authority()
        const counts = yield* this.query((orm) =>
          orm.select({ n: count() }).from(terminalRuns)
        )
        const cancellations = yield* this.query((orm) =>
          orm
            .select({ id: terminalCancellations.id })
            .from(terminalCancellations)
            .where(eq(terminalCancellations.id, input.id))
        )
        const policy = yield* this.networkPolicy()
        const next = yield* decision(() =>
          newCommandRecord(
            input,
            kind,
            transfer,
            authority,
            counts[0]!.n,
            cancellations.length > 0,
            policy.unrestricted,
            Date.now(),
            attemptId
          )
        )
        return { run: yield* this.put(next), fresh: next.status === "running" }
      })
    )
  }
  blocked() {
    return this.query((orm) =>
      orm.select({ record: terminalRuns.record }).from(terminalRuns)
    ).pipe(
      Effect.map((rows) =>
        rows.some((row) => {
          const run = decode(row)
          return (
            run.occupancy.state === "blocked" ||
            (run.status === "running" && run.occupancy.state === "free")
          )
        })
      )
    )
  }
  occupied() {
    return this.query((orm) =>
      orm.select({ record: terminalRuns.record }).from(terminalRuns)
    ).pipe(
      Effect.map((rows) =>
        rows.some((row) => {
          const run = decode(row)
          return run.occupancy.state !== "free" || run.status === "running"
        })
      )
    )
  }
  private occupancy(event: OccupancyEvent) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const rows = yield* this.query((orm) =>
          orm.select({ record: terminalRuns.record }).from(terminalRuns)
        )
        for (const row of rows) {
          const run = decode(row)
          const occupancy = advanceTerminalOccupancy(run.occupancy, event)
          if (
            occupancy.state !== run.occupancy.state ||
            occupancy.ownerId !== run.occupancy.ownerId
          )
            yield* this.put({ ...run, occupancy, revision: run.revision + 1 })
        }
      })
    )
  }
  cleaning(ownerId: string) {
    return this.occupancy({ type: "CLEAN", ownerId })
  }
  release(ownerId: string, confirmed: boolean) {
    return this.occupancy({ type: "RELEASE", ownerId, confirmed })
  }
  progress(id: string, output: string, attemptId: string) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const run = yield* this.get(id)
        if (run) {
          const next = advanceCommandRecord(run, {
            type: "PROGRESS",
            attemptId,
            output,
          })
          if (next.revision !== run.revision) yield* this.put(next)
        }
      })
    )
  }
  finish(
    id: string,
    result: Pick<CommandRun, "status" | "exitCode" | "error">,
    checkpoint?: Checkpoint,
    exported?: Checkpoint,
    attemptId?: string
  ) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const run = yield* this.get(id)
        if (!run)
          return yield* new TerminalFailure({ message: "Command not found." })
        if (run.status !== "running") return { run, changed: false }
        const allowed = yield* this.authorized(run)
        const cancelled = yield* this.cancelled(id)
        const next = advanceCommandRecord(run, {
          type: "FINISH",
          attemptId: attemptId ?? run.attemptId,
          result: Schema.decodeUnknownSync(
            Schema.Struct({
              status: Schema.Literals([
                "succeeded",
                "failed",
                "cancelled",
                "interrupted",
              ]),
              exitCode: CommandRunResult.fields.exitCode,
              error: CommandRunResult.fields.error,
            })
          )(result),
          cancelled,
          publishing: !!(checkpoint || exported),
          allowed,
          savedAt: checkpoint?.savedAt ?? null,
          now: Date.now(),
        })
        if (next.revision === run.revision) return { run, changed: false }
        if (next.status !== "cancelled") {
          if (exported)
            yield* this.query((orm) =>
              orm
                .insert(terminalExports)
                .values({ id, record: JSON.stringify(exported) })
            )
          if (checkpoint)
            yield* this.query((orm) =>
              orm
                .insert(terminalCheckpoint)
                .values({ id: 1, record: JSON.stringify(checkpoint) })
                .onConflictDoUpdate({
                  target: terminalCheckpoint.id,
                  set: { record: JSON.stringify(checkpoint) },
                })
            )
        }
        return { run: yield* this.put(next), changed: true }
      })
    ).pipe(
      Effect.tap(({ run, changed }) =>
        changed ? Effect.sync(() => this.observe(run)) : Effect.void
      ),
      Effect.map(({ run }) => commandResult(run))
    )
  }
  private observe(run: CommandRun) {
    try {
      this.onFinished?.(commandResult(run))
    } catch {}
  }
  recover(ownerId: string = crypto.randomUUID()) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const rows = yield* this.query((orm) =>
          orm.select({ record: terminalRuns.record }).from(terminalRuns)
        )
        const changed: CommandRecord[] = []
        for (const row of rows) {
          const run = decode(row)
          const next = advanceCommandRecord(run, {
            type: "RECOVER",
            now: Date.now(),
          })
          const occupancy = advanceTerminalOccupancy(next.occupancy, {
            type: "RECOVER",
            ownerId,
          })
          if (
            next.revision !== run.revision ||
            occupancy.state !== run.occupancy.state ||
            occupancy.ownerId !== run.occupancy.ownerId
          ) {
            const saved = yield* this.put({
              ...next,
              occupancy,
              revision: next.revision + 1,
            })
            if (next.status !== run.status) changed.push(saved)
          }
        }
        return changed
      })
    ).pipe(
      Effect.flatMap((runs) =>
        Effect.sync(() => {
          for (const run of runs) this.observe(run)
        })
      )
    )
  }
}
