import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"

import {
  mapSqliteError,
  type Sqlite,
  type EffectSqliteDatabase,
} from "../../storage/sqlite"
import { browserApplication } from "../browser"
import { BrowserFailure, type BrowserRecord } from "../contracts"
import {
  BrowserRecordSchema,
  initialBrowser,
  resetBrowser,
  transferBrowser,
  updateBrowser,
} from "../domain"
import type { BrowserDriver, BrowserUnavailable } from "../driver"
import { BrowserStorageError, type BrowserRepository } from "../repository"
import { botBrowser, retiredBrowsers } from "./schema"

const LegacyRecord = Schema.Struct({
  ...BrowserRecordSchema.fields,
  controller: Schema.optionalKey(BrowserRecordSchema.fields.controller),
  unrestricted: Schema.optionalKey(Schema.Boolean),
})
const change = <TValue>(body: () => TValue) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      if (cause instanceof BrowserFailure) return cause
      throw cause
    },
  })
export class BrowserStore implements BrowserRepository {
  constructor(private readonly db: Sqlite) {}
  private query<TValue, TError, TRequirements>(
    body: (
      orm: EffectSqliteDatabase
    ) => Effect.Effect<TValue, TError, TRequirements>
  ) {
    return mapSqliteError(this.db.use(body), () => new BrowserStorageError())
  }
  atomic<TValue, TError, TRequirements>(
    body: () => Effect.Effect<TValue, TError, TRequirements>
  ) {
    return mapSqliteError(
      this.db.transaction(body),
      () => new BrowserStorageError()
    )
  }
  read(): Effect.Effect<BrowserRecord, BrowserStorageError> {
    return this.query((orm) =>
      orm
        .select({ record: botBrowser.record })
        .from(botBrowser)
        .where(eq(botBrowser.id, 1))
    ).pipe(
      Effect.map((rows) => {
        if (!rows[0]) return initialBrowser()
        const record = Schema.decodeUnknownSync(LegacyRecord)(
          JSON.parse(rows[0].record)
        )
        return {
          ...record,
          controller: record.controller ?? "agent",
          unrestricted: record.unrestricted ?? false,
        }
      })
    )
  }
  private write(value: BrowserRecord) {
    return Effect.suspend(() => {
      const record = JSON.stringify(value)
      return this.query((orm) =>
        orm
          .insert(botBrowser)
          .values({ id: 1, record })
          .onConflictDoUpdate({ target: botBrowser.id, set: { record } })
      ).pipe(Effect.asVoid)
    })
  }
  update(
    generation: number,
    patch: Partial<
      Pick<BrowserRecord, "status" | "session" | "capture" | "error">
    >
  ) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const current = yield* this.read()
        const next = yield* change(() =>
          updateBrowser(current, generation, patch)
        )
        yield* this.write(next)
        return next
      })
    )
  }
  reset(generation: number, hosts: readonly string[], unrestricted = false) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const current = yield* this.read()
        const next = yield* change(() =>
          resetBrowser(current, generation, hosts, unrestricted)
        )
        if (current.session) yield* this.retire(current.session.id)
        yield* this.write(next)
        return next
      })
    )
  }
  transfer(generation: number, controller: "agent" | "owner") {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const current = yield* this.read()
        const next = yield* change(() =>
          transferBrowser(current, generation, controller)
        )
        yield* this.write(next)
        return next
      })
    )
  }
  retire(id: string) {
    return this.query((orm) =>
      orm.insert(retiredBrowsers).values({ id }).onConflictDoNothing()
    ).pipe(Effect.asVoid)
  }
  retired() {
    return this.query((orm) =>
      orm.select({ id: retiredBrowsers.id }).from(retiredBrowsers)
    ).pipe(
      Effect.map((rows) =>
        rows.map((row) => Schema.decodeUnknownSync(Schema.String)(row.id))
      )
    )
  }
  forget(id: string) {
    return this.query((orm) =>
      orm.delete(retiredBrowsers).where(eq(retiredBrowsers.id, id))
    ).pipe(Effect.asVoid)
  }
}
export const sqliteBrowserLayer = (
  db: Sqlite,
  driver: BrowserDriver,
  writable: () => Effect.Effect<boolean, BrowserStorageError>,
  wake: () => Effect.Effect<void, BrowserUnavailable>
) => browserApplication(new BrowserStore(db), driver, writable, wake)
