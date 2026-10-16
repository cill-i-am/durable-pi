import type { Effect } from "effect"
import type {
  Skill,
  SkillDocument,
  SkillSelection,
  SaveSkill,
  SelectSkills,
  SkillConflict,
  SkillStorageError,
} from "./contracts"

export type SkillError = SkillConflict | SkillStorageError
export interface SkillLedger {
  readonly transactionGroup: object
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
  selection: () => Effect.Effect<SkillSelection, SkillError>
  select: (
    expectedRevision: number,
    skills: readonly SkillDocument[],
    canWrite?: () => Effect.Effect<boolean, SkillError>
  ) => Effect.Effect<SkillSelection, SkillError>
}
export interface SkillSelectionRepository {
  selection: () => Effect.Effect<SkillSelection, SkillError>
  select: (
    expectedRevision: number,
    skills: readonly SkillDocument[],
    canWrite: () => Effect.Effect<boolean, SkillError>
  ) => Effect.Effect<SkillSelection, SkillError>
}
