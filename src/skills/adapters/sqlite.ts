import { Effect, Schema } from "effect"
import { and, desc, eq, getTableColumns } from "drizzle-orm"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"
import { mapSqliteError, type Sqlite } from "../../storage/sqlite"
import {
  SkillConflict,
  SkillStorageError,
  SkillDocument,
  SkillSelection,
  type SaveSkill,
  type SelectSkills,
} from "../contracts"
import { SkillSource } from "../source"
import * as Domain from "../domain"
import type { SkillError, SkillLedger } from "../repository"
import {
  workspaceSkills as skills,
  workspaceSkillVersions as versions,
  botSkills,
} from "./schema"

const document = (row: {
  id: string
  revision: number
  name: string
  body: string
  createdAt: string
  source: string | null
}) => {
  const { source, ...value } = row
  return Schema.decodeUnknownSync(SkillDocument)({
    ...value,
    ...(source
      ? { source: Schema.decodeUnknownSync(SkillSource)(JSON.parse(source)) }
      : {}),
  })
}
const query = <TValue>(
  operation: string,
  effect: Effect.Effect<TValue, EffectDrizzleQueryError>
) =>
  mapSqliteError(effect, (cause) => new SkillStorageError({ operation, cause }))
const decision = <TValue>(body: () => TValue) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      if (Schema.is(SkillConflict)(cause)) return cause
      throw cause
    },
  })
export class SkillStore implements SkillLedger {
  readonly transactionGroup: object
  constructor(private readonly db: Sqlite) {
    this.transactionGroup = db
  }
  private atomic<TValue, TError, TRequirements>(
    body: () => Effect.Effect<TValue, TError, TRequirements>
  ) {
    return mapSqliteError(
      this.db.transaction(body),
      (cause) => new SkillStorageError({ operation: "transaction", cause })
    )
  }
  list() {
    return this.db
      .use((orm) =>
        query(
          "read",
          orm
            .select({
              ...getTableColumns(versions),
              archived: skills.archived,
              stateRevision: skills.stateRevision,
            })
            .from(skills)
            .innerJoin(
              versions,
              and(
                eq(skills.id, versions.id),
                eq(skills.revision, versions.revision)
              )
            )
            .orderBy(versions.name, skills.id)
        )
      )
      .pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            ...document(row),
            archived: !!row.archived,
            stateRevision: row.stateRevision,
          }))
        )
      )
  }
  versions(id: string) {
    return this.db
      .use((orm) =>
        query(
          "read",
          orm
            .select()
            .from(versions)
            .where(eq(versions.id, id))
            .orderBy(desc(versions.revision))
        )
      )
      .pipe(Effect.map((rows) => rows.map(document)))
  }
  save(input: SaveSkill) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const library = yield* this.list(),
          current = library.find((s) => s.id === input.id)
        const next = yield* decision(() =>
          Domain.saveSkill(
            input,
            current,
            current ? 0 : library.length,
            new Date().toISOString()
          )
        )
        if (next === current) return current
        yield* this.db.use((orm) =>
          query(
            "write",
            orm
              .insert(skills)
              .values({
                id: next.id,
                revision: next.revision,
                archived: 0,
                stateRevision: next.stateRevision,
              })
              .onConflictDoUpdate({
                target: skills.id,
                set: {
                  revision: next.revision,
                  stateRevision: next.stateRevision,
                },
              })
          )
        )
        yield* this.db.use((orm) =>
          query(
            "write",
            orm.insert(versions).values({
              ...next,
              source: next.source ? JSON.stringify(next.source) : null,
            })
          )
        )
        return next
      })
    )
  }
  archive(id: string, revision: number, archived: boolean) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const current = (yield* this.list()).find((s) => s.id === id)
        const next = yield* decision(() =>
          Domain.archiveSkill(current, revision, archived)
        )
        if (next !== current)
          yield* this.db.use((orm) =>
            query(
              "write",
              orm
                .update(skills)
                .set({
                  archived: archived ? 1 : 0,
                  stateRevision: next.stateRevision,
                })
                .where(eq(skills.id, id))
            )
          )
        return next
      })
    )
  }
  resolve(references: SelectSkills["skills"]) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        yield* decision(() => Domain.uniqueReferences(references))
        const library = yield* this.list()
        return yield* Effect.forEach(references, (ref) =>
          Effect.gen({ self: this }, function* () {
            yield* decision(() => Domain.requireAvailableSkill(library, ref.id))
            const value = (yield* this.versions(ref.id)).find(
              (v) => v.revision === ref.revision
            )
            if (!value)
              return yield* new SkillConflict({
                message: "This skill revision is unavailable.",
              })
            return value
          })
        )
      })
    )
  }
  selection() {
    return this.db
      .use((orm) =>
        query("read", orm.select().from(botSkills).where(eq(botSkills.id, 1)))
      )
      .pipe(
        Effect.map(([row]) =>
          row
            ? Schema.decodeUnknownSync(SkillSelection)({
                revision: row.revision,
                skills: JSON.parse(row.skills),
              })
            : { revision: 0, skills: [] }
        )
      )
  }
  select(
    revision: number,
    documents: readonly SkillDocument[],
    canWrite: () => Effect.Effect<boolean, SkillError> = () =>
      Effect.succeed(true)
  ) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        if (!(yield* canWrite()))
          return yield* new SkillConflict({
            message: "Restore this bot before changing its skills.",
          })
        const current = yield* this.selection(),
          next = yield* decision(() =>
            Domain.selectSkills(current, revision, documents)
          )
        if (next !== current)
          yield* this.db.use((orm) =>
            query(
              "write",
              orm
                .insert(botSkills)
                .values({
                  id: 1,
                  revision: next.revision,
                  skills: JSON.stringify(next.skills),
                })
                .onConflictDoUpdate({
                  target: botSkills.id,
                  set: {
                    revision: next.revision,
                    skills: JSON.stringify(next.skills),
                  },
                })
            )
          )
        return next
      })
    )
  }
}
