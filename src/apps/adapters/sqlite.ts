import { and, asc, count, desc, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"

import {
  mapSqliteError,
  type Sqlite,
  type EffectSqliteDatabase,
} from "../../storage/sqlite"
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
  WebResult,
} from "../contracts"
import type { AppAdmission, AppLedger } from "../repository"
import {
  generatedApps,
  generatedAppVersions,
  generatedAppOperations,
  generatedAppEvents,
} from "./schema"

const decision = <TValue>(body: () => TValue) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      if (cause instanceof AppConflict) return cause
      throw cause
    },
  })
type AppError = AppConflict | AppStorageError
export class AppStore implements AppLedger {
  readonly transactionGroup: object
  constructor(
    private readonly db: Sqlite,
    private readonly active: () => Effect.Effect<boolean, AppStorageError>
  ) {
    this.transactionGroup = db
  }
  private query<TValue, TError, TRequirements>(
    body: (
      orm: EffectSqliteDatabase
    ) => Effect.Effect<TValue, TError, TRequirements>
  ) {
    return mapSqliteError(
      this.db.use(body),
      (cause) => new AppStorageError({ operation: "query", cause })
    )
  }
  private atomic<TValue, TError, TRequirements>(
    body: () => Effect.Effect<TValue, TError, TRequirements>
  ) {
    return mapSqliteError(
      this.db.transaction(body),
      (cause) => new AppStorageError({ operation: "transaction", cause })
    )
  }
  list() {
    return this.query((orm) =>
      orm
        .select({ record: generatedApps.record })
        .from(generatedApps)
        .orderBy(desc(generatedApps.sequence))
    ).pipe(
      Effect.map((rows) =>
        rows.map((row) =>
          Schema.decodeUnknownSync(AppDocument)(JSON.parse(row.record))
        )
      )
    )
  }
  get(id: string) {
    return this.query((orm) =>
      orm
        .select({ record: generatedApps.record })
        .from(generatedApps)
        .where(eq(generatedApps.id, id))
    ).pipe(
      Effect.map((rows) =>
        rows[0]
          ? Schema.decodeUnknownSync(AppDocument)(JSON.parse(rows[0].record))
          : undefined
      )
    )
  }
  version(id: string, version: number) {
    return this.query((orm) =>
      orm
        .select({ record: generatedAppVersions.record })
        .from(generatedAppVersions)
        .where(
          and(
            eq(generatedAppVersions.id, id),
            eq(generatedAppVersions.version, version)
          )
        )
    ).pipe(
      Effect.flatMap((rows) =>
        rows[0]
          ? Effect.sync(() =>
              Schema.decodeUnknownSync(AppVersion)(JSON.parse(rows[0]!.record))
            )
          : Effect.fail(
              new AppConflict({ message: "This app version is unavailable." })
            )
      )
    )
  }
  detail(id: string) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const app = yield* this.get(id)
        if (!app)
          return yield* new AppConflict({
            message: "This app is unavailable in this bot.",
          })
        const versions = yield* this.query((orm) =>
          orm
            .select({ record: generatedAppVersions.record })
            .from(generatedAppVersions)
            .where(eq(generatedAppVersions.id, id))
            .orderBy(desc(generatedAppVersions.version))
        )
        const events = yield* this.query((orm) =>
          orm
            .select({ record: generatedAppEvents.record })
            .from(generatedAppEvents)
            .where(eq(generatedAppEvents.app_id, id))
            .orderBy(desc(generatedAppEvents.sequence))
            .limit(20)
        )
        return {
          app,
          versions: versions.map((row) =>
            Schema.decodeUnknownSync(AppVersion)(JSON.parse(row.record))
          ),
          events: events.map((row) =>
            Schema.decodeUnknownSync(AppEvent)(JSON.parse(row.record))
          ),
        }
      })
    )
  }
  private put(app: AppDocument) {
    const record = JSON.stringify(app)
    return this.query((orm) =>
      orm
        .insert(generatedApps)
        .values({ id: app.id, record })
        .onConflictDoUpdate({ target: generatedApps.id, set: { record } })
    ).pipe(Effect.as(app))
  }
  private current(id: string, revision: number, allowArchived = false) {
    return this.get(id).pipe(
      Effect.flatMap((app) =>
        decision(() => Domain.currentApp(app, revision, allowArchived))
      )
    )
  }
  private available() {
    return this.active().pipe(
      Effect.flatMap((active) =>
        active
          ? Effect.void
          : Effect.fail(
              new AppConflict({
                message: "Restore this bot before changing its apps.",
              })
            )
      )
    )
  }
  private operation(
    operationId: string,
    input: unknown,
    execute: () => Effect.Effect<AppDocument, AppError>
  ) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        yield* this.available()
        const encoded = JSON.stringify(input)
        const rows = yield* this.query((orm) =>
          orm
            .select({
              input: generatedAppOperations.input,
              result: generatedAppOperations.result,
            })
            .from(generatedAppOperations)
            .where(eq(generatedAppOperations.id, operationId))
        )
        const previous = rows[0]
        if (previous) {
          if (previous.input !== encoded)
            return yield* new AppConflict({
              message: "This operation ID belongs to another change.",
            })
          return Schema.decodeUnknownSync(AppDocument)(
            JSON.parse(previous.result)
          )
        }
        const counts = yield* this.query((orm) =>
          orm.select({ n: count() }).from(generatedAppOperations)
        )
        yield* decision(() => Domain.operationCapacity(counts[0]!.n))
        const result = yield* execute()
        yield* this.query((orm) =>
          orm.insert(generatedAppOperations).values({
            id: operationId,
            input: encoded,
            result: JSON.stringify(result),
          })
        )
        return result
      })
    )
  }
  save(raw: SaveApp) {
    return Effect.suspend(() => {
      const input = Schema.decodeUnknownSync(SaveApp)(raw)
      return this.operation(input.operationId, { type: "save", ...input }, () =>
        Effect.gen({ self: this }, function* () {
          const current = yield* this.get(input.id),
            total = current ? 0 : (yield* this.list()).length
          const change = yield* decision(() =>
            Domain.saveApp(input, current, total, new Date().toISOString())
          )
          const saved = yield* this.put(change.app)
          yield* this.query((orm) =>
            orm.insert(generatedAppVersions).values({
              id: input.id,
              version: change.version.version,
              record: JSON.stringify(change.version),
            })
          )
          return saved
        })
      )
    })
  }
  publish(raw: PublishApp) {
    return Effect.suspend(() => {
      const input = Schema.decodeUnknownSync(PublishApp)(raw)
      return this.operation(
        input.operationId,
        { type: "publish", ...input },
        () =>
          Effect.gen({ self: this }, function* () {
            const current = yield* this.current(
                input.id,
                input.expectedRevision
              ),
              version = yield* this.version(input.id, input.version)
            const app = yield* decision(() =>
              Domain.publishApp(current, version)
            )
            return yield* this.put(app)
          })
      )
    })
  }
  archive(raw: ArchiveApp) {
    return Effect.suspend(() => {
      const input = Schema.decodeUnknownSync(ArchiveApp)(raw)
      return this.operation(
        input.operationId,
        { type: "archive", ...input },
        () =>
          Effect.gen({ self: this }, function* () {
            const current = yield* this.current(
              input.id,
              input.expectedRevision,
              true
            )
            return yield* this.put(Domain.archiveApp(current, input.archived))
          })
      )
    })
  }
  interactionReceipt(raw: InteractApp) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const input = Schema.decodeUnknownSync(InteractApp)(raw)
        yield* this.available()
        const rows = yield* this.query((orm) =>
          orm
            .select({
              input: generatedAppOperations.input,
              result: generatedAppOperations.result,
            })
            .from(generatedAppOperations)
            .where(eq(generatedAppOperations.id, input.operationId))
        )
        const previous = rows[0]
        if (!previous) return undefined
        if (previous.input !== JSON.stringify({ type: "interact", ...input }))
          return yield* new AppConflict({
            message: "This operation ID belongs to another change.",
          })
        return Schema.decodeUnknownSync(AppDocument)(
          JSON.parse(previous.result)
        )
      })
    )
  }
  interactionSnapshot(input: InteractApp) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        yield* this.available()
        const current = yield* this.current(input.id, input.expectedRevision)
        return yield* decision(() =>
          Domain.interactionSnapshot(current, input.version)
        )
      })
    )
  }
  interact(raw: InteractApp, webResult?: WebResult) {
    return Effect.suspend(() => {
      const input = Schema.decodeUnknownSync(InteractApp)(raw)
      return this.operation(
        input.operationId,
        { type: "interact", ...input },
        () =>
          Effect.gen({ self: this }, function* () {
            const current = yield* this.interactionSnapshot(input),
              version = yield* this.version(input.id, input.version),
              pending = yield* this.pending()
            const result = webResult
              ? Schema.decodeUnknownSync(WebResult)(webResult)
              : undefined
            const change = yield* decision(() =>
              Domain.interactionChange(
                current,
                version,
                input,
                pending.length,
                crypto.randomUUID(),
                new Date().toISOString(),
                result
              )
            )
            yield* this.query((orm) =>
              orm.insert(generatedAppEvents).values({
                id: change.event.id,
                app_id: change.event.appId,
                record: JSON.stringify(change.event),
                queued: 0,
              })
            )
            return yield* this.put(change.app)
          })
      )
    })
  }
  pending() {
    return this.query((orm) =>
      orm
        .select({ record: generatedAppEvents.record })
        .from(generatedAppEvents)
        .where(eq(generatedAppEvents.queued, 0))
        .orderBy(asc(generatedAppEvents.sequence))
        .limit(20)
    ).pipe(
      Effect.map((rows) =>
        rows.map((row) =>
          Schema.decodeUnknownSync(AppEvent)(JSON.parse(row.record))
        )
      )
    )
  }
  cancelOperation(id: string) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const rows = yield* this.query((orm) =>
          orm
            .select({ result: generatedAppOperations.result })
            .from(generatedAppOperations)
            .where(eq(generatedAppOperations.id, id))
        )
        if (rows[0]) return { applied: rows[0].result !== "null" }
        const counts = yield* this.query((orm) =>
          orm.select({ n: count() }).from(generatedAppOperations)
        )
        yield* decision(() => Domain.operationCapacity(counts[0]!.n))
        yield* this.query((orm) =>
          orm
            .insert(generatedAppOperations)
            .values({ id, input: "", result: "null" })
        )
        return { applied: false }
      })
    )
  }
  deliverNext(admission: AppAdmission, discoveryDeadline: number) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        if (admission.transactionGroup !== this.transactionGroup)
          throw new Error(
            "App admission must share its storage transaction group."
          )
        if (!(yield* this.active())) return false
        const event = (yield* this.pending())[0]
        if (!event) return false
        if ((yield* admission.admit(event, discoveryDeadline)) !== event.turnId)
          throw new Error("App admission returned a different turn identity.")
        yield* this.query((orm) =>
          orm
            .update(generatedAppEvents)
            .set({
              queued: 1,
              record: JSON.stringify({ ...event, delivery: "queued" }),
            })
            .where(eq(generatedAppEvents.id, event.id))
        )
        return true
      })
    )
  }
}
