import { Schema } from "effect"
import type { Sqlite } from "../../storage/sqlite"
import { applyAction, retainState } from "../app"
import {
  AppConflict,
  AppDocument,
  AppVersion,
  AppEvent,
  SaveApp,
  PublishApp,
  ArchiveApp,
  InteractApp,
  type AppDetail,
  WebResult,
} from "../contracts"

export class AppStore {
  constructor(
    private readonly db: Sqlite,
    private readonly active: () => boolean
  ) {
    db.run(
      "CREATE TABLE IF NOT EXISTS generated_apps (id TEXT PRIMARY KEY,record TEXT NOT NULL)"
    )
    db.run(
      "CREATE TABLE IF NOT EXISTS generated_app_versions (id TEXT NOT NULL,version INTEGER NOT NULL,record TEXT NOT NULL,PRIMARY KEY(id,version))"
    )
    db.run(
      "CREATE TABLE IF NOT EXISTS generated_app_operations (id TEXT PRIMARY KEY,input TEXT NOT NULL,result TEXT NOT NULL)"
    )
    db.run(
      "CREATE TABLE IF NOT EXISTS generated_app_events (id TEXT PRIMARY KEY,app_id TEXT NOT NULL,record TEXT NOT NULL,queued INTEGER NOT NULL DEFAULT 0)"
    )
  }
  list(): AppDocument[] {
    return this.db
      .all<{ record: string }>(
        "SELECT record FROM generated_apps ORDER BY rowid DESC"
      )
      .map(({ record }) =>
        Schema.decodeUnknownSync(AppDocument)(JSON.parse(record))
      )
  }
  get(id: string) {
    const row = this.db.all<{ record: string }>(
      "SELECT record FROM generated_apps WHERE id=?",
      id
    )[0]
    return row
      ? Schema.decodeUnknownSync(AppDocument)(JSON.parse(row.record))
      : undefined
  }
  version(id: string, version: number): AppVersion {
    const row = this.db.all<{ record: string }>(
      "SELECT record FROM generated_app_versions WHERE id=? AND version=?",
      id,
      version
    )[0]
    if (!row)
      throw new AppConflict({ message: "This app version is unavailable." })
    return Schema.decodeUnknownSync(AppVersion)(JSON.parse(row.record))
  }
  detail(id: string): AppDetail {
    const app = this.get(id)
    if (!app)
      throw new AppConflict({ message: "This app is unavailable in this bot." })
    return {
      app,
      versions: this.db
        .all<{ record: string }>(
          "SELECT record FROM generated_app_versions WHERE id=? ORDER BY version DESC",
          id
        )
        .map(({ record }) =>
          Schema.decodeUnknownSync(AppVersion)(JSON.parse(record))
        ),
      events: this.db
        .all<{ record: string }>(
          "SELECT record FROM generated_app_events WHERE app_id=? ORDER BY rowid DESC LIMIT 20",
          id
        )
        .map(({ record }) =>
          Schema.decodeUnknownSync(AppEvent)(JSON.parse(record))
        ),
    }
  }
  private put(app: AppDocument) {
    this.db.run(
      "INSERT INTO generated_apps VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record",
      app.id,
      JSON.stringify(app)
    )
    return app
  }
  private current(id: string, revision: number, allowArchived = false) {
    const app = this.get(id)
    if (!app || app.revision !== revision)
      throw new AppConflict({
        message: "This app changed. Reload before making this change.",
      })
    if (app.archived && !allowArchived)
      throw new AppConflict({ message: "Restore this app before changing it." })
    return app
  }
  private operation(
    operationId: string,
    input: unknown,
    execute: () => AppDocument
  ) {
    return this.db.transaction(() => {
      if (!this.active())
        throw new AppConflict({
          message: "Restore this bot before changing its apps.",
        })
      const encoded = JSON.stringify(input)
      const previous = this.db.all<{ input: string; result: string }>(
        "SELECT input,result FROM generated_app_operations WHERE id=?",
        operationId
      )[0]
      if (previous) {
        if (previous.input !== encoded)
          throw new AppConflict({
            message: "This operation ID belongs to another change.",
          })
        return Schema.decodeUnknownSync(AppDocument)(
          JSON.parse(previous.result)
        )
      }
      if (
        this.db.all<{ n: number }>(
          "SELECT count(*) AS n FROM generated_app_operations"
        )[0]!.n >= 2000
      )
        throw new AppConflict({
          message: "This bot has reached its app operation limit.",
        })
      const result = execute()
      this.db.run(
        "INSERT INTO generated_app_operations VALUES (?,?,?)",
        operationId,
        encoded,
        JSON.stringify(result)
      )
      return result
    })
  }
  save(raw: SaveApp) {
    const input = Schema.decodeUnknownSync(SaveApp)(raw)
    return this.operation(input.operationId, { type: "save", ...input }, () => {
      const current = this.get(input.id)
      if (current) this.current(input.id, input.expectedRevision)
      else if (input.expectedRevision !== 0 || this.list().length >= 50)
        throw new AppConflict({
          message:
            "Reload the app. Each bot supports at most 50 apps, including archived apps.",
        })
      if ((current?.version ?? 0) >= 50)
        throw new AppConflict({
          message: "This app has reached its 50-version limit.",
        })
      const version: AppVersion = {
        id: input.id,
        version: (current?.version ?? 0) + 1,
        definition: input.definition,
        createdAt: new Date().toISOString(),
      }
      this.db.run(
        "INSERT INTO generated_app_versions VALUES (?,?,?)",
        input.id,
        version.version,
        JSON.stringify(version)
      )
      return this.put({
        ...version,
        revision: (current?.revision ?? 0) + 1,
        publishedVersion: current?.publishedVersion ?? null,
        archived: false,
        state: current?.state ?? { checks: {}, forms: {} },
      })
    })
  }
  publish(raw: PublishApp) {
    const input = Schema.decodeUnknownSync(PublishApp)(raw)
    return this.operation(
      input.operationId,
      { type: "publish", ...input },
      () => {
        const current = this.current(input.id, input.expectedRevision)
        const version = this.version(input.id, input.version)
        return this.put({
          ...current,
          publishedVersion: version.version,
          revision: current.revision + 1,
          state: retainState(version.definition, current.state),
        })
      }
    )
  }
  archive(raw: ArchiveApp) {
    const input = Schema.decodeUnknownSync(ArchiveApp)(raw)
    return this.operation(
      input.operationId,
      { type: "archive", ...input },
      () => {
        const current = this.current(input.id, input.expectedRevision, true)
        return this.put({
          ...current,
          archived: input.archived,
          revision: current.revision + 1,
        })
      }
    )
  }
  interactionReceipt(raw: InteractApp) {
    const input = Schema.decodeUnknownSync(InteractApp)(raw)
    if (!this.active())
      throw new AppConflict({
        message: "Restore this bot before changing its apps.",
      })
    const previous = this.db.all<{ input: string; result: string }>(
      "SELECT input,result FROM generated_app_operations WHERE id=?",
      input.operationId
    )[0]
    if (!previous) return undefined
    if (previous.input !== JSON.stringify({ type: "interact", ...input }))
      throw new AppConflict({
        message: "This operation ID belongs to another change.",
      })
    return Schema.decodeUnknownSync(AppDocument)(JSON.parse(previous.result))
  }
  interactionSnapshot(input: InteractApp) {
    if (!this.active())
      throw new AppConflict({
        message: "Restore this bot before changing its apps.",
      })
    const current = this.current(input.id, input.expectedRevision)
    if (current.publishedVersion !== input.version)
      throw new AppConflict({
        message: "The published app changed. Reload before interacting.",
      })
    return current
  }
  interact(raw: InteractApp, webResult?: WebResult) {
    const input = Schema.decodeUnknownSync(InteractApp)(raw)
    return this.operation(
      input.operationId,
      { type: "interact", ...input },
      () => {
        const current = this.current(input.id, input.expectedRevision)
        if (current.publishedVersion !== input.version)
          throw new AppConflict({
            message: "The published app changed. Reload before interacting.",
          })
        if (this.pending().length >= 20)
          throw new AppConflict({
            message:
              "Twenty app updates are waiting for this bot. Reconnect its model before sending more.",
          })
        const { state, text } = applyAction(
          this.version(input.id, input.version).definition,
          current.state,
          input.action,
          webResult ? Schema.decodeUnknownSync(WebResult)(webResult) : undefined
        )
        const event: AppEvent = {
          id: input.operationId,
          appId: input.id,
          turnId: crypto.randomUUID(),
          version: input.version,
          text: `App ${input.id}, published version ${input.version}.\n${text}`,
          createdAt: new Date().toISOString(),
          delivery: "pending",
        }
        if (!Schema.is(AppEvent)(event))
          throw new AppConflict({
            message:
              "This update is too large. Shorten the form responses and try again.",
          })
        this.db.run(
          "INSERT INTO generated_app_events VALUES (?,?,?,0)",
          event.id,
          event.appId,
          JSON.stringify(event)
        )
        return this.put({ ...current, revision: current.revision + 1, state })
      }
    )
  }
  pending(): AppEvent[] {
    return this.db
      .all<{ record: string }>(
        "SELECT record FROM generated_app_events WHERE queued=0 ORDER BY rowid LIMIT 20"
      )
      .map(({ record }) =>
        Schema.decodeUnknownSync(AppEvent)(JSON.parse(record))
      )
  }
  cancelOperation(id: string) {
    return this.db.transaction(() => {
      const previous = this.db.all<{ result: string }>(
        "SELECT result FROM generated_app_operations WHERE id=?",
        id
      )[0]
      if (previous) return { applied: previous.result !== "null" }
      if (
        this.db.all<{ n: number }>(
          "SELECT count(*) AS n FROM generated_app_operations"
        )[0]!.n >= 2000
      )
        throw new AppConflict({
          message: "This bot has reached its app operation limit.",
        })
      this.db.run(
        "INSERT INTO generated_app_operations VALUES (?,'','null')",
        id
      )
      return { applied: false }
    })
  }
  deliverNext(admit: (event: AppEvent) => void) {
    return this.db.transaction(() => {
      if (!this.active()) return false
      const event = this.pending()[0]
      if (!event) return false
      admit(event)
      this.db.run(
        "UPDATE generated_app_events SET queued=1,record=? WHERE id=?",
        JSON.stringify({ ...event, delivery: "queued" }),
        event.id
      )
      return true
    })
  }
}
