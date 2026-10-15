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

export interface SkillLedger {
  readonly transactionGroup: object
  list: () => Skill[]
  versions: (id: string) => SkillDocument[]
  save: (input: SaveSkill) => Skill
  archive: (id: string, expectedRevision: number, archived: boolean) => Skill
  resolve: (references: SelectSkills["skills"]) => SkillDocument[]
  selection: () => SkillSelection
  select: (
    expectedRevision: number,
    skills: readonly SkillDocument[]
  ) => SkillSelection
}
export type SkillError = SkillConflict | SkillStorageError
export interface SkillSelectionRepository {
  selection: () => Effect.Effect<SkillSelection, SkillError>
  select: (
    expectedRevision: number,
    skills: readonly SkillDocument[],
    canWrite: () => boolean
  ) => Effect.Effect<SkillSelection, SkillError>
}
