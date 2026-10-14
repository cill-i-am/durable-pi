import type { Sqlite } from "../../storage/sqlite"
import {
  ConnectionError,
  connectionUrl,
  type NewConnection,
  type RemoteTool,
  type ToolSelection,
} from "../connections"

export type SavedConnection = NewConnection & {
  revision: number
  active: boolean
}
export class ConnectionStore {
  constructor(private readonly db: Sqlite) {
    db.run(
      "CREATE TABLE IF NOT EXISTS access_connections (id TEXT PRIMARY KEY,name TEXT NOT NULL,url TEXT NOT NULL,revision INTEGER NOT NULL,active INTEGER NOT NULL)"
    )
    db.run(
      "CREATE TABLE IF NOT EXISTS bot_remote_tools (id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,tools TEXT NOT NULL)"
    )
  }
  list(): SavedConnection[] {
    return this.db
      .all<Omit<SavedConnection, "active"> & { active: number }>(
        "SELECT * FROM access_connections ORDER BY name,id"
      )
      .map((row) => ({ ...row, active: !!row.active }))
  }
  get(id: string) {
    return this.list().find((value) => value.id === id)
  }
  add(input: NewConnection) {
    const url = connectionUrl(input.url),
      previous = this.get(input.id)
    if (previous) {
      if (previous.url !== url || previous.name !== input.name)
        throw new ConnectionError({
          message: "This connection ID is already in use.",
        })
      return previous
    }
    if (this.list().length >= 20)
      throw new ConnectionError({
        message: "This workspace supports up to 20 connection records.",
      })
    this.db.run(
      "INSERT INTO access_connections VALUES (?,?,?,1,1)",
      input.id,
      input.name,
      url
    )
    return this.get(input.id)!
  }
  change(id: string, expectedRevision: number, active: boolean) {
    return this.db.transaction(() => {
      const current = this.get(id)
      if (!current)
        throw new ConnectionError({ message: "Connection not found." })
      if (
        current.active === active &&
        current.revision === expectedRevision + 1
      )
        return current
      if (current.revision !== expectedRevision)
        throw new ConnectionError({
          message: "This connection changed. Reload before updating it.",
        })
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
      ? { revision: row.revision, tools: JSON.parse(row.tools) }
      : { revision: 0, tools: [] }
  }
  select(expectedRevision: number, tools: readonly RemoteTool[]) {
    if (
      tools.length > 16 ||
      new Set(tools.map((tool) => tool.name)).size !== tools.length
    )
      throw new ConnectionError({ message: "Choose up to 16 distinct tools." })
    return this.db.transaction(() => {
      const current = this.selection(),
        serialized = JSON.stringify(tools)
      if (current.revision !== expectedRevision) {
        if (
          current.revision === expectedRevision + 1 &&
          JSON.stringify(current.tools) === serialized
        )
          return current
        throw new ConnectionError({
          message: "The selected tools changed. Reload before updating them.",
        })
      }
      if (new TextEncoder().encode(serialized).byteLength > 600_000)
        throw new ConnectionError({
          message: "These tool definitions exceed the selection limit.",
        })
      this.db.run(
        "INSERT INTO bot_remote_tools VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,tools=excluded.tools",
        current.revision + 1,
        serialized
      )
      return this.selection()
    })
  }
}
