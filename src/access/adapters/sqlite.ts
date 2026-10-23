import { and, desc, eq, inArray, lte, notInArray } from "drizzle-orm"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"
import { Effect, Schema } from "effect"

import { mapSqliteError, type Sqlite } from "../../storage/sqlite"
import {
  AccessStorageError,
  AccessConflict,
  AccessDenied,
  Approval,
  type AccessMode,
  type ToolPolicy,
} from "../contracts"
import * as Domain from "../domain"
import type { AccessError } from "../gate"
import { ToolOperation, type AccessLedger, type ToolIntent } from "../ledger"
import {
  advanceOperation,
  beginOperation,
  type OperationEvent,
} from "../operation.machine"
import {
  toolGrants as grants,
  toolOperations as operations,
  toolOperationHistory as history,
} from "./schema"

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
          row ? Schema.decodeUnknownSync(ToolOperation)(row) : undefined
        )
      )
  }
  private change(operation: ToolOperation, next: ToolOperation) {
    return Effect.gen({ self: this }, function* () {
      if (next.revision === operation.revision) return operation
      yield* this.db.use((orm) =>
        query(
          "write",
          orm
            .update(operations)
            .set(next)
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
    event: Extract<OperationEvent, { type: "EXPIRE" | "CANCEL" | "REVOKE" }>
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
                event.type === "EXPIRE"
                  ? lte(operations.expiresAt, event.now)
                  : undefined
              )
            )
        )
      )
      for (const row of rows) {
        const previous = Schema.decodeUnknownSync(ToolOperation)(row)
        const next = yield* decision(() => advanceOperation(previous, event))
        yield* this.change(previous, next.operation)
      }
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
          yield* this.changeOpen(name, undefined, { type: "REVOKE" })
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
      this.changeOpen(undefined, undefined, { type: "EXPIRE", now: this.now() })
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
        const runnable = yield* canRun(input.turnId)
        yield* this.expire()
        const previous = yield* this.get(input.id)
        if (previous)
          return (yield* decision(() =>
            advanceOperation(previous, {
              type: "BEGIN",
              intent: input,
              runnable,
              pending: 0,
              policy: null,
            })
          )).operation
        const policy = yield* this.policy(input.tool),
          pending = yield* this.pending(),
          operation = yield* decision(() =>
            beginOperation(input, this.now(), {
              type: "BEGIN",
              intent: input,
              policy,
              pending: pending.length,
              runnable,
            })
          )
        yield* this.db.use((orm) =>
          query("write", orm.insert(operations).values(operation))
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
          const previous = yield* this.get(id)
          if (!previous)
            return yield* new AccessConflict({
              message: "This approval no longer exists.",
            })
          const policies =
            previous.status === "pending" ? yield* this.policies() : []
          const change = yield* decision(() =>
            advanceOperation(previous, {
              type: "DECIDE",
              approve,
              expectedRevision: revision,
              remember: remember ?? null,
              policy:
                policies.find((policy) => policy.name === previous.tool) ??
                null,
            })
          )
          const operation = change.operation
          const grant = change.commands.find(
            (command) => command.type === "grant"
          )
          if (grant)
            yield* this.db.use((orm) =>
              query(
                "write",
                orm
                  .insert(grants)
                  .values({
                    name: operation.tool,
                    mode: "allow",
                    revision: grant.revision,
                  })
                  .onConflictDoUpdate({
                    target: grants.name,
                    set: {
                      mode: "allow",
                      revision: grant.revision,
                    },
                  })
              )
            )
          return yield* this.change(previous, operation)
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
          const operation = yield* this.get(id)
          if (!operation)
            return yield* new AccessDenied({
              message: "This tool operation is unavailable.",
            })
          const runnable = yield* canRun(operation.turnId)
          const policy = yield* this.policy(operation.tool)
          const change = yield* decision(() =>
            advanceOperation(operation, {
              type: "CLAIM",
              policy,
              recoverable,
              now: this.now(),
              runnable,
            })
          )
          yield* this.change(operation, change.operation)
          const command = change.commands.find(
            (value) => value.type === "dispatch" || value.type === "reject"
          )
          if (!command) throw new Error("Access claim produced no decision")
          return command.type === "reject"
            ? new AccessDenied({ message: command.message })
            : command.decision
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
        if (operation) {
          const next = yield* decision(() =>
            advanceOperation(operation, { type: "FINISH", result })
          )
          yield* this.change(operation, next.operation)
        }
      })
    )
  }
  cancel(turnId: string) {
    return this.atomic(() =>
      this.changeOpen(undefined, turnId, { type: "CANCEL" })
    )
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
        yield* this.changeOpen(name, undefined, { type: "REVOKE" })
      })
    )
  }
}
