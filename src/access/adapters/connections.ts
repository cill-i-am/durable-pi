import { Effect, Schema } from "effect"
import { eq } from "drizzle-orm"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"
import { mapSqliteError, type Sqlite } from "../../storage/sqlite"
import type {
  ConnectionLedger,
  ConnectionFailure,
  RemoteSelectionRepository,
} from "../connection-ledger"
import * as Domain from "../connection-domain"
import {
  ConnectionError,
  ConnectionStorageError,
  SavedConnection,
  ToolSelection,
  type NewConnection,
  type RemoteTool,
} from "../connections"
import { accessConnections as connections, botRemoteTools } from "./schema"

const query = <TValue>(
  operation: string,
  effect: Effect.Effect<TValue, EffectDrizzleQueryError>
) =>
  mapSqliteError(
    effect,
    (cause) => new ConnectionStorageError({ operation, cause })
  )
const decision = <TValue>(body: () => TValue) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      if (Schema.is(ConnectionError)(cause)) return cause
      throw cause
    },
  })
export class ConnectionStore implements ConnectionLedger {
  constructor(private readonly db: Sqlite) {}
  private atomic<TValue, TError, TRequirements>(
    body: () => Effect.Effect<TValue, TError, TRequirements>
  ) {
    return mapSqliteError(
      this.db.transaction(body),
      (cause) => new ConnectionStorageError({ operation: "transaction", cause })
    )
  }
  list() {
    return this.db
      .use((orm) =>
        query(
          "read",
          orm
            .select()
            .from(connections)
            .orderBy(connections.name, connections.id)
        )
      )
      .pipe(
        Effect.map((rows) =>
          rows.map((row) =>
            Schema.decodeUnknownSync(SavedConnection)({
              ...row,
              active: !!row.active,
            })
          )
        )
      )
  }
  get(id: string) {
    return this.db
      .use((orm) =>
        query(
          "read",
          orm.select().from(connections).where(eq(connections.id, id))
        )
      )
      .pipe(
        Effect.map(([row]) =>
          row
            ? Schema.decodeUnknownSync(SavedConnection)({
                ...row,
                active: !!row.active,
              })
            : undefined
        )
      )
  }
  add(input: NewConnection) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const previous = yield* this.get(input.id),
          records = yield* this.list()
        const next = yield* decision(() =>
          Domain.addConnection(input, previous, records.length)
        )
        if (next === previous) return previous
        yield* this.db.use((orm) =>
          query(
            "write",
            orm
              .insert(connections)
              .values({ ...next, active: next.active ? 1 : 0 })
          )
        )
        return next
      })
    )
  }
  change(id: string, revision: number, active: boolean) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const current = yield* this.get(id),
          next = yield* decision(() =>
            Domain.changeConnection(current, revision, active)
          )
        if (next !== current)
          yield* this.db.use((orm) =>
            query(
              "write",
              orm
                .update(connections)
                .set({ active: active ? 1 : 0, revision: next.revision })
                .where(eq(connections.id, id))
            )
          )
        return next
      })
    )
  }
  selection() {
    return this.db
      .use((orm) =>
        query(
          "read",
          orm.select().from(botRemoteTools).where(eq(botRemoteTools.id, 1))
        )
      )
      .pipe(
        Effect.map(([row]) =>
          row
            ? Schema.decodeUnknownSync(ToolSelection)({
                revision: row.revision,
                tools: JSON.parse(row.tools),
              })
            : { revision: 0, tools: [] }
        )
      )
  }
  select(
    revision: number,
    tools: readonly RemoteTool[],
    canWrite: () => Effect.Effect<boolean, ConnectionFailure> = () =>
      Effect.succeed(true)
  ) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const writable = yield* canWrite()
        yield* decision(() => Domain.requireSelectionWrite(writable))
        const current = yield* this.selection(),
          next = yield* decision(() =>
            Domain.selectTools(current, revision, tools)
          )
        if (next !== current)
          yield* this.db.use((orm) =>
            query(
              "write",
              orm
                .insert(botRemoteTools)
                .values({
                  id: 1,
                  revision: next.revision,
                  tools: JSON.stringify(next.tools),
                })
                .onConflictDoUpdate({
                  target: botRemoteTools.id,
                  set: {
                    revision: next.revision,
                    tools: JSON.stringify(next.tools),
                  },
                })
            )
          )
        return next
      })
    )
  }
}
export function sqliteRemoteSelection(
  store: ConnectionLedger
): RemoteSelectionRepository {
  return {
    selection: () => store.selection(),
    select: (revision, tools, canWrite) =>
      store.select(revision, tools, canWrite),
  }
}
