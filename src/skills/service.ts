import { Context, Effect, Layer } from "effect"
import {
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

export const makeSkills = (ledger: SkillLedger) =>
  Skills.of({
    list: Effect.fn("Skills.list")(() => ledger.list()),
    versions: Effect.fn("Skills.versions")((id: string) => ledger.versions(id)),
    save: Effect.fn("Skills.save")((input: SaveSkill) => ledger.save(input)),
    archive: Effect.fn("Skills.archive")(
      (id: string, revision: number, archived: boolean) =>
        ledger.archive(id, revision, archived)
    ),
    resolve: Effect.fn("Skills.resolve")((references: SelectSkills["skills"]) =>
      ledger.resolve(references)
    ),
    selection: Effect.fn("Skills.selection")(() => ledger.selection()),
    select: Effect.fn("Skills.select")(
      (
        revision: number,
        skills: readonly SkillDocument[],
        canWrite: () => Effect.Effect<boolean, SkillError>
      ) => ledger.select(revision, skills, canWrite)
    ),
  })
export const skillApplication = (ledger: SkillLedger) =>
  Layer.succeed(Skills, makeSkills(ledger))
