import { and, asc, count, desc, eq } from "drizzle-orm"
import { Clock, Effect, Schema } from "effect"

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
  AppEvent,
  AppVersion,
  SaveApp,
  PublishApp,
  ArchiveApp,
  InteractApp,
  WebResult,
} from "../contracts"
import {
  advanceAppDelivery,
  restoreAppDelivery,
  type AppDeliveryRecord,
} from "../delivery.machine"
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
        yield* this.exhaustDelivery(() => true, true)
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
            Schema.decodeUnknownSync(AppEvent)(
              restoreAppDelivery(JSON.parse(row.record))
            )
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
  interact(
    raw: InteractApp,
    webResult?: WebResult,
    discoveryDeadline?: number
  ) {
    return Effect.suspend(() => {
      const input = Schema.decodeUnknownSync(InteractApp)(raw)
      return this.operation(
        input.operationId,
        { type: "interact", ...input },
        () =>
          Effect.gen({ self: this }, function* () {
            if (
              discoveryDeadline !== undefined &&
              discoveryDeadline <= (yield* Clock.currentTimeMillis)
            )
              return yield* new AppConflict({
                message:
                  "App admission discovery expired. Retry the same interaction.",
              })
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
                record: JSON.stringify(restoreAppDelivery(change.event)),
                queued: 0,
              })
            )
            return yield* this.put(change.app)
          })
      )
    })
  }
  pending() {
    return this.atomic(() =>
      this.exhaustDelivery(() => true, true).pipe(
        Effect.andThen(this.deliveryRecords())
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
  renderSnapshot(id: string, version: number) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        yield* this.available()
        const app = yield* this.get(id)
        if (!app || app.archived)
          return yield* new AppConflict({
            message: "Restore this app before rendering it.",
          })
        // Draft previews remain supported; interactions always require published authority.
        yield* this.version(id, version)
        return app
      })
    )
  }
  private writeDelivery(record: AppDeliveryRecord) {
    return this.query((orm) =>
      orm
        .update(generatedAppEvents)
        .set({
          queued: record.lifecycle.state === "pending" ? 0 : 1,
          record: JSON.stringify(record),
        })
        .where(eq(generatedAppEvents.id, record.id))
    ).pipe(Effect.asVoid)
  }
  private deliveryRecords() {
    return this.query((orm) =>
      orm
        .select({
          record: generatedAppEvents.record,
          queued: generatedAppEvents.queued,
        })
        .from(generatedAppEvents)
        .where(eq(generatedAppEvents.queued, 0))
        .orderBy(asc(generatedAppEvents.sequence))
        .limit(20)
    ).pipe(
      Effect.map((rows) =>
        rows.map((row) => {
          const record = restoreAppDelivery(JSON.parse(row.record))
          if (record.lifecycle.state !== "pending")
            throw new Error(
              "App delivery index disagrees with its machine state"
            )
          return record
        })
      )
    )
  }
  exhaustDelivery(eligible: () => boolean, expiredOnly: boolean) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const now = yield* Clock.currentTimeMillis
        const records = yield* this.deliveryRecords()
        if (!eligible()) return
        for (const record of records) {
          if (expiredOnly && record.lifecycle.deadline > now) continue
          yield* this.writeDelivery(
            advanceAppDelivery(record, {
              type: "EXHAUST",
              revision: record.lifecycle.revision,
              message:
                "Conversation admission could not be confirmed within the bounded recovery budget. Saved app state and its interaction receipt are retained. Resolve the model or storage failure, then send a new interaction to notify the bot.",
            })
          )
        }
      })
    )
  }
  nextDelivery() {
    return this.pending().pipe(
      Effect.map((records) =>
        records.length
          ? Math.min(
              records[0]!.lifecycle.nextAt,
              records[0]!.lifecycle.deadline
            )
          : undefined
      )
    )
  }
  deferDelivery(
    id: string,
    reason: "model" | "capacity" | "storage",
    now: number
  ) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const record = (yield* this.deliveryRecords()).find(
          (value) => value.id === id
        )
        if (record)
          yield* this.writeDelivery(
            advanceAppDelivery(record, {
              type: "DEFER",
              revision: record.lifecycle.revision,
              reason,
              now,
            })
          )
      })
    )
  }
  cancelPending(message: string) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        if (yield* this.active()) return
        for (const record of yield* this.deliveryRecords())
          yield* this.writeDelivery(
            advanceAppDelivery(record, {
              type: "CANCEL",
              revision: record.lifecycle.revision,
              message,
            })
          )
      })
    )
  }
  /** Called only for an accepted bot archive in the configuration transaction.
   * Reuse app revisions to revoke prepared work without changing saved values
   * or the immutable operation receipts that an exact replay must return. */
  revokeBotAuthority(message: string) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        if (yield* this.active()) return
        yield* this.cancelPending(message)
        for (const app of yield* this.list())
          yield* this.put({ ...app, revision: app.revision + 1 })
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
        if (!(yield* this.active())) {
          yield* this.cancelPending(
            "This bot was archived before conversation admission. Saved app state is retained."
          )
          return false
        }
        yield* this.exhaustDelivery(() => true, true)
        const now = yield* Clock.currentTimeMillis
        const event = (yield* this.deliveryRecords())[0]
        if (!event || event.lifecycle.nextAt > now) return false
        const app = yield* this.get(event.appId)
        if (!app || app.archived || app.publishedVersion !== event.version) {
          yield* this.writeDelivery(
            advanceAppDelivery(event, {
              type: "CANCEL",
              revision: event.lifecycle.revision,
              message:
                "The app was archived or its published version changed before conversation admission. Saved state and the interaction receipt are retained.",
            })
          )
          return false
        }
        const next = advanceAppDelivery(event, {
          type: "ADMIT",
          revision: event.lifecycle.revision,
        })
        if (next.lifecycle.state !== "admitted") return false
        if ((yield* admission.admit(event, discoveryDeadline)) !== event.turnId)
          throw new Error("App admission returned a different turn identity.")
        yield* this.writeDelivery(next)
        return true
      })
    )
  }
}
