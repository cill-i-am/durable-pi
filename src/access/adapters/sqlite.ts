import { Effect, Schema } from "effect"
import { and, desc, eq, inArray, lte, notInArray } from "drizzle-orm"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"
import { mapSqliteError, type Sqlite } from "../../storage/sqlite"
import {
  AccessStorageError,
  AccessConflict,
  AccessDenied,
  Approval,
  type AccessMode,
  type ToolPolicy,
} from "../contracts"
import type { AccessError } from "../gate"
import type { AccessLedger, ToolIntent, ToolOperation } from "../ledger"
import * as Domain from "../domain"
import {
  toolGrants as grants,
  toolOperations as operations,
  toolOperationHistory as history,
} from "./schema"

const Operation = Schema.Struct({
  ...Approval.fields,
  grantRevision: Schema.Number,
  result: Schema.NullOr(Schema.String),
  decision: Schema.NullOr(Schema.String),
})
const query = <TValue>(
  operation: string,
  effect: Effect.Effect<TValue, EffectDrizzleQueryError>
) =>
  mapSqliteError(
    effect,
    (cause) => new AccessStorageError({ operation, cause })
  )
const decision = <TValue>(body: () => TValue) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      if (Schema.is(AccessConflict)(cause) || Schema.is(AccessDenied)(cause))
        return cause
      throw cause
    },
  })
export class AccessStore implements AccessLedger {
  constructor(
    private readonly db: Sqlite,
    private readonly catalog: () => Effect.Effect<
      readonly Omit<ToolPolicy, "revision">[],
      AccessError
    >,
    private readonly now = Date.now
  ) {}
  private atomic<TValue, TError, TRequirements>(
    body: () => Effect.Effect<TValue, TError, TRequirements>
  ) {
    return mapSqliteError(
      this.db.transaction(body),
      (cause) => new AccessStorageError({ operation: "transaction", cause })
    )
  }
  policies() {
    return this.db
      .use((orm) => query("read", orm.select().from(grants)))
      .pipe(
        Effect.flatMap((rows) =>
          this.catalog().pipe(
            Effect.map((catalog) => {
              const saved = new Map(rows.map((row) => [row.name, row]))
              return catalog
                .map((tool) => ({
                  ...tool,
                  revision: 0,
                  ...saved.get(tool.name),
                  name: tool.name,
                }))
                .map((tool) => ({
                  ...tool,
                  mode: Schema.decodeUnknownSync(
                    Schema.Literals(["allow", "ask", "deny"])
                  )(tool.mode),
                }))
            })
          )
        )
      )
  }

  policy(name: string) {
    return this.policies().pipe(
      Effect.flatMap((rows) =>
        decision(() =>
          Domain.requirePolicy(rows.find((tool) => tool.name === name))
        )
      )
    )
  }
  get(id: string) {
    return this.db
      .use((orm) =>
        query(
          "read",
          orm.select().from(operations).where(eq(operations.id, id))
        )
      )
      .pipe(
        Effect.map(([row]) =>
          row ? Schema.decodeUnknownSync(Operation)(row) : undefined
        )
      )
  }
  private change(
    operation: ToolOperation,
    patch: Partial<Omit<ToolOperation, "id" | "revision">>
  ) {
    return Effect.gen({ self: this }, function* () {
      const next = { ...operation, ...patch, revision: operation.revision + 1 }
      yield* this.db.use((orm) =>
        query(
          "write",
          orm
            .update(operations)
            .set({ ...patch, revision: next.revision })
            .where(eq(operations.id, operation.id))
        )
      )
      if (next.status !== operation.status)
        yield* this.db.use((orm) =>
          query(
            "write",
            orm.insert(history).values({
              operationId: next.id,
              revision: next.revision,
              status: next.status,
              at: Math.max(next.createdAt, this.now()),
            })
          )
        )
      return next
    })
  }
  private changeOpen(
    tool: string | undefined,
    turnId: string | undefined,
    status: ToolOperation["status"],
    expired = false
  ) {
    return Effect.gen({ self: this }, function* () {
      const rows = yield* this.db.use((orm) =>
        query(
          "read",
          orm
            .select()
            .from(operations)
            .where(
              and(
                inArray(operations.status, ["pending", "approved"]),
                tool === undefined ? undefined : eq(operations.tool, tool),
                turnId === undefined
                  ? undefined
                  : eq(operations.turnId, turnId),
                expired ? lte(operations.expiresAt, this.now()) : undefined
              )
            )
        )
      )
      for (const row of rows)
        yield* this.change(Schema.decodeUnknownSync(Operation)(row), { status })
    })
  }
  update(name: string, revision: number, mode: AccessMode) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const current = yield* this.policy(name),
          next = yield* decision(() =>
            Domain.revisePolicy(current, revision, mode)
          )
        if (next === current) return current
        yield* this.db.use((orm) =>
          query(
            "write",
            orm
              .insert(grants)
              .values({ name, mode: next.mode, revision: next.revision })
              .onConflictDoUpdate({
                target: grants.name,
                set: { mode: next.mode, revision: next.revision },
              })
          )
        )
        if (next.mode === "deny")
          yield* this.changeOpen(name, undefined, "denied")
        return yield* this.policy(name)
      })
    )
  }
  receipts(turnIds: readonly string[]) {
    if (!turnIds.length) return Effect.succeed([])
    return this.db
      .use((orm) =>
        query(
          "read",
          orm
            .select({ id: operations.id, revision: operations.revision })
            .from(operations)
            .where(
              and(
                inArray(operations.turnId, [...turnIds]),
                eq(operations.status, "done"),
                notInArray(operations.tool, ["update_plan", "read_plan"])
              )
            )
            .orderBy(desc(operations.createdAt))
            .limit(20)
        )
      )
      .pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            ...row,
            id: Schema.decodeUnknownSync(Schema.String)(row.id),
          }))
        )
      )
  }
  expire() {
    return this.atomic(() =>
      this.changeOpen(undefined, undefined, "expired", true)
    )
  }
  pending() {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        yield* this.expire()
        const rows = yield* this.db.use((orm) =>
          query(
            "read",
            orm
              .select()
              .from(operations)
              .where(inArray(operations.status, ["pending", "approved"]))
              .orderBy(operations.createdAt, operations.id)
          )
        )
        return rows.map((row) => Schema.decodeUnknownSync(Approval)(row))
      })
    )
  }
  awaitingApproval(turnId: string) {
    return this.db
      .use((orm) =>
        query(
          "read",
          orm
            .select({ id: operations.id, expiresAt: operations.expiresAt })
            .from(operations)
            .where(
              and(
                eq(operations.turnId, turnId),
                eq(operations.status, "pending")
              )
            )
        )
      )
      .pipe(
        Effect.map((rows) => rows.some((row) => row.expiresAt > this.now()))
      )
  }
  begin(
    input: ToolIntent,
    canRun: (turnId: string) => Effect.Effect<boolean, AccessError> = () =>
      Effect.succeed(true)
  ) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        if (!(yield* canRun(input.turnId)))
          return yield* new AccessDenied({
            message: "This reply has stopped or its bot is archived.",
          })
        yield* this.expire()
        const previous = yield* this.get(input.id),
          existing = yield* decision(() => Domain.replayIntent(input, previous))
        if (existing) return existing
        const policy = yield* this.policy(input.tool),
          pending = yield* this.pending(),
          operation = yield* decision(() =>
            Domain.admitOperation(input, policy, pending.length, this.now())
          )
        yield* this.db.use((orm) =>
          query(
            "write",
            orm.insert(operations).values({
              ...operation,
              revision: 0,
              result: null,
              decision: null,
            })
          )
        )
        yield* this.db.use((orm) =>
          query(
            "write",
            orm.insert(history).values({
              operationId: operation.id,
              revision: 0,
              status: operation.status,
              at: operation.createdAt,
            })
          )
        )
        return (yield* this.get(input.id))!
      })
    )
  }
  decide(
    id: string,
    approve: boolean,
    revision: number,
    remember?: { expectedPolicyRevision: number }
  ) {
    return Effect.gen({ self: this }, function* () {
      yield* this.expire()
      return yield* this.atomic(() =>
        Effect.gen({ self: this }, function* () {
          const identity = yield* decision(() =>
            Domain.decisionIdentity(approve, revision, remember)
          )
          const previous = yield* this.get(id),
            round = yield* decision(() =>
              Domain.approvalRound(
                previous,
                approve,
                revision,
                identity,
                remember
              )
            )
          if (round.replay) return round.operation
          const policy = yield* this.policy(round.operation.tool),
            change = yield* decision(() =>
              Domain.decideOperation(
                round.operation,
                policy,
                approve,
                identity,
                remember
              )
            ),
            operation = change.operation
          if (change.grant)
            yield* this.db.use((orm) =>
              query(
                "write",
                orm
                  .insert(grants)
                  .values({
                    name: operation.tool,
                    mode: change.grant!.mode,
                    revision: change.grant!.revision,
                  })
                  .onConflictDoUpdate({
                    target: grants.name,
                    set: {
                      mode: change.grant!.mode,
                      revision: change.grant!.revision,
                    },
                  })
              )
            )
          return yield* this.change(round.operation, {
            status: operation.status,
            grantRevision: operation.grantRevision,
            decision: operation.decision,
          })
        })
      )
    })
  }
  claim(
    id: string,
    recoverable = false,
    canRun: (turnId: string) => Effect.Effect<boolean, AccessError> = () =>
      Effect.succeed(true)
  ) {
    return Effect.gen({ self: this }, function* () {
      yield* this.expire()
      return yield* this.atomic(() =>
        Effect.gen({ self: this }, function* () {
          const previous = yield* this.get(id),
            operation = yield* decision(() =>
              Domain.requireOperation(previous)
            ),
            runnable = yield* canRun(operation.turnId)
          if (!runnable)
            return yield* new AccessDenied({
              message: "This reply has stopped or its bot is archived.",
            })
          const policy = yield* this.policy(operation.tool),
            change = yield* decision(() =>
              Domain.claimOperation(operation, policy, recoverable, this.now())
            )
          if (change.update)
            yield* this.change(operation, {
              status: change.update.status,
              grantRevision: change.update.grantRevision,
            })
          return change.decision
        })
      ).pipe(
        Effect.flatMap((value) =>
          typeof value === "object" && "_tag" in value
            ? Effect.fail(value)
            : Effect.succeed(value)
        )
      )
    })
  }
  finish(id: string, result: string) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        yield* decision(() => Domain.validateResult(result))
        const operation = yield* this.get(id)
        if (operation?.status === "running")
          yield* this.change(operation, { status: "done", result })
      })
    )
  }
  cancel(turnId: string) {
    return this.atomic(() => this.changeOpen(undefined, turnId, "cancelled"))
  }
  revoke(name: string) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const rows = yield* this.db.use((orm) =>
          query("read", orm.select().from(grants).where(eq(grants.name, name)))
        )
        const grant = rows[0]
        if (grant)
          yield* this.db.use((orm) =>
            query(
              "write",
              orm
                .update(grants)
                .set({ mode: "ask", revision: grant.revision + 1 })
                .where(eq(grants.name, name))
            )
          )
        yield* this.changeOpen(name, undefined, "denied")
      })
    )
  }
}
