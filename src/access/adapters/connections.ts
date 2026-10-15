import { Effect, Schema } from "effect"
import type { Sqlite } from "../../storage/sqlite"
import type {
  ConnectionLedger,
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

export class ConnectionStore implements ConnectionLedger {
  constructor(private readonly db: Sqlite) {
    const storage = <T>(operation: string, body: () => T): T => {
      try {
        return body()
      } catch (cause) {
        throw new ConnectionStorageError({ operation, cause })
      }
    }
    this.db = {
      all: (query, ...bindings) =>
        storage("read", () => db.all(query, ...bindings)),
      run: (query, ...bindings) =>
        storage("write", () => db.run(query, ...bindings)),
      transaction: (body) => {
        const callback: { failed: boolean; cause?: unknown } = { failed: false }
        try {
          return db.transaction(() => {
            try {
              return body()
            } catch (cause) {
              callback.failed = true
              callback.cause = cause
              throw cause
            }
          })
        } catch (cause) {
          if (callback.failed && cause === callback.cause) throw cause
          throw new ConnectionStorageError({ operation: "transaction", cause })
        }
      },
    }
    this.db.run(
      "CREATE TABLE IF NOT EXISTS access_connections (id TEXT PRIMARY KEY,name TEXT NOT NULL,url TEXT NOT NULL,revision INTEGER NOT NULL,active INTEGER NOT NULL)"
    )
    this.db.run(
      "CREATE TABLE IF NOT EXISTS bot_remote_tools (id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,tools TEXT NOT NULL)"
    )
  }
  list(): SavedConnection[] {
    return this.db
      .all<Omit<SavedConnection, "active"> & { active: number }>(
        "SELECT * FROM access_connections ORDER BY name,id"
      )
      .map((row) =>
        Schema.decodeUnknownSync(SavedConnection)({
          ...row,
          active: !!row.active,
        })
      )
  }
  get(id: string) {
    return this.list().find((value) => value.id === id)
  }
  add(input: NewConnection) {
    return this.db.transaction(() => {
      const previous = this.get(input.id)
      const next = Domain.addConnection(input, previous, this.list().length)
      if (next === previous) return previous
      this.db.run(
        "INSERT INTO access_connections VALUES (?,?,?,?,?)",
        next.id,
        next.name,
        next.url,
        next.revision,
        next.active ? 1 : 0
      )
      return this.get(input.id)!
    })
  }
  change(id: string, expectedRevision: number, active: boolean) {
    return this.db.transaction(() => {
      const current = this.get(id)
      const next = Domain.changeConnection(current, expectedRevision, active)
      if (next === current) return current
      this.db.run(
        "UPDATE access_connections SET active=?,revision=revision+1 WHERE id=?",
        active ? 1 : 0,
        id
      )
      return this.get(id)!
    })
  }
  selection(): ToolSelection {
    const row = this.db.all<{ revision: number; tools: string }>(
      "SELECT * FROM bot_remote_tools WHERE id=1"
    )[0]
    return row
      ? Schema.decodeUnknownSync(ToolSelection)({
          revision: row.revision,
          tools: JSON.parse(row.tools),
        })
      : { revision: 0, tools: [] }
  }
  select(expectedRevision: number, tools: readonly RemoteTool[]) {
    return this.db.transaction(() => {
      const current = this.selection()
      const next = Domain.selectTools(current, expectedRevision, tools)
      if (next === current) return current
      this.db.run(
        "INSERT INTO bot_remote_tools VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,tools=excluded.tools",
        next.revision,
        JSON.stringify(next.tools)
      )
      return this.selection()
    })
  }
}

const attempt = <T>(body: () => T) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      const knownFailure = Schema.decodeUnknownOption(
        Schema.Union([ConnectionError, ConnectionStorageError])
      )(cause)
      if (knownFailure._tag === "Some") return knownFailure.value
      throw cause
    },
  })
export function sqliteRemoteSelection(
  store: ConnectionLedger
): RemoteSelectionRepository {
  return {
    selection: () => attempt(() => store.selection()),
    select: (revision, tools, canWrite) =>
      attempt(() => {
        Domain.requireSelectionWrite(canWrite())
        return store.select(revision, tools)
      }),
  }
}
