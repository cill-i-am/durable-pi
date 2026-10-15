import { Schema } from "effect"
import type { Sqlite } from "../../storage/sqlite"
import * as Domain from "../app"
import {
  AppConflict,
  AppStorageError,
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

import type { AppAdmission, AppLedger } from "../repository"

export class AppStore implements AppLedger {
  readonly transactionGroup: object
  constructor(
    private readonly db: Sqlite,
    private readonly active: () => boolean
  ) {
    this.transactionGroup = db
    const storage = <T>(operation: string, body: () => T): T => {
      try {
        return body()
      } catch (cause) {
        throw new AppStorageError({ operation, cause })
      }
    }
    this.db = {
      all: (query, ...bindings) =>
        storage("read", () => db.all(query, ...bindings)),
      run: (query, ...bindings) =>
        storage("write", () => db.run(query, ...bindings)),
      transaction: (body) => {
        const failure: { failed: boolean; cause?: unknown } = { failed: false }
        try {
          return db.transaction(() => {
            try {
              return body()
            } catch (cause) {
              failure.failed = true
              failure.cause = cause
              throw cause
            }
          })
        } catch (cause) {
          if (failure.failed && cause === failure.cause) throw cause
          throw new AppStorageError({ operation: "transaction", cause })
        }
      },
    }

    this.db.run(
      "CREATE TABLE IF NOT EXISTS generated_apps (id TEXT PRIMARY KEY,record TEXT NOT NULL)"
    )
    this.db.run(
      "CREATE TABLE IF NOT EXISTS generated_app_versions (id TEXT NOT NULL,version INTEGER NOT NULL,record TEXT NOT NULL,PRIMARY KEY(id,version))"
    )
    this.db.run(
      "CREATE TABLE IF NOT EXISTS generated_app_operations (id TEXT PRIMARY KEY,input TEXT NOT NULL,result TEXT NOT NULL)"
    )
    this.db.run(
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
    return Domain.currentApp(this.get(id), revision, allowArchived)
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
      Domain.operationCapacity(
        this.db.all<{ n: number }>(
          "SELECT count(*) AS n FROM generated_app_operations"
        )[0]!.n
      )
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
      const change = Domain.saveApp(
        input,
        current,
        current ? 0 : this.list().length,
        new Date().toISOString()
      )
      this.db.run(
        "INSERT INTO generated_app_versions VALUES (?,?,?)",
        input.id,
        change.version.version,
        JSON.stringify(change.version)
      )
      return this.put(change.app)
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
        return this.put(Domain.publishApp(current, version))
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
        return this.put(Domain.archiveApp(current, input.archived))
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
    return Domain.interactionSnapshot(
      this.current(input.id, input.expectedRevision),
      input.version
    )
  }

  interact(raw: InteractApp, webResult?: WebResult) {
    const input = Schema.decodeUnknownSync(InteractApp)(raw)
    return this.operation(
      input.operationId,
      { type: "interact", ...input },
      () => {
        const current = Domain.interactionSnapshot(
          this.current(input.id, input.expectedRevision),
          input.version
        )
        const change = Domain.interactionChange(
          current,
          this.version(input.id, input.version),
          input,
          this.pending().length,
          crypto.randomUUID(),
          new Date().toISOString(),
          webResult ? Schema.decodeUnknownSync(WebResult)(webResult) : undefined
        )
        this.db.run(
          "INSERT INTO generated_app_events VALUES (?,?,?,0)",
          change.event.id,
          change.event.appId,
          JSON.stringify(change.event)
        )
        return this.put(change.app)
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
      Domain.operationCapacity(
        this.db.all<{ n: number }>(
          "SELECT count(*) AS n FROM generated_app_operations"
        )[0]!.n
      )
      this.db.run(
        "INSERT INTO generated_app_operations VALUES (?,'','null')",
        id
      )
      return { applied: false }
    })
  }
  deliverNext(admission: AppAdmission) {
    if (admission.transactionGroup !== this.transactionGroup)
      throw new Error("App admission must share its storage transaction group.")
    return this.db.transaction(() => {
      if (!this.active()) return false
      const event = this.pending()[0]
      if (!event) return false
      if (admission.admit(event) !== event.turnId)
        throw new Error("App admission returned a different turn identity.")
      this.db.run(
        "UPDATE generated_app_events SET queued=1,record=? WHERE id=?",
        JSON.stringify({ ...event, delivery: "queued" }),
        event.id
      )
      return true
    })
  }
}
