import { Schema, Context, Effect, Layer } from "effect"
import {
  SkillConflict,
  SkillStorageError,
  type Skill,
  type SkillDocument,
  type SaveSkill,
  type SelectSkills,
} from "./contracts"
import type {
  SkillError,
  SkillLedger,
  SkillSelectionRepository,
} from "./repository"

export class Skills extends Context.Service<
  Skills,
  SkillSelectionRepository & {
    list: () => Effect.Effect<Skill[], SkillError>
    versions: (id: string) => Effect.Effect<SkillDocument[], SkillError>
    save: (input: SaveSkill) => Effect.Effect<Skill, SkillError>
    archive: (
      id: string,
      expectedRevision: number,
      archived: boolean
    ) => Effect.Effect<Skill, SkillError>
    resolve: (
      references: SelectSkills["skills"]
    ) => Effect.Effect<SkillDocument[], SkillError>
  }
>()("durable-pi/skills/Skills") {}

const attempt = <T>(body: () => T) =>
  Effect.try({
    try: body,
    catch(cause) {
      const knownFailure = Schema.decodeUnknownOption(
        Schema.Union([SkillConflict, SkillStorageError])
      )(cause)
      if (knownFailure._tag === "Some") return knownFailure.value
      throw cause
    },
  })
export const makeSkills = (ledger: SkillLedger) =>
  Skills.of({
    list: Effect.fn("Skills.list")(() => attempt(() => ledger.list())),
    versions: Effect.fn("Skills.versions")((id: string) =>
      attempt(() => ledger.versions(id))
    ),
    save: Effect.fn("Skills.save")((input: SaveSkill) =>
      attempt(() => ledger.save(input))
    ),
    archive: Effect.fn("Skills.archive")(
      (id: string, revision: number, archived: boolean) =>
        attempt(() => ledger.archive(id, revision, archived))
    ),
    resolve: Effect.fn("Skills.resolve")((references: SelectSkills["skills"]) =>
      attempt(() => ledger.resolve(references))
    ),
    selection: Effect.fn("Skills.selection")(() =>
      attempt(() => ledger.selection())
    ),
    select: Effect.fn("Skills.select")(
      (
        revision: number,
        skills: readonly SkillDocument[],
        canWrite: () => boolean
      ) =>
        attempt(() => {
          if (!canWrite())
            throw new SkillConflict({
              message: "Restore this bot before changing its skills.",
            })
          return ledger.select(revision, skills)
        })
    ),
  })
export const skillApplication = (ledger: SkillLedger) =>
  Layer.succeed(Skills, makeSkills(ledger))
