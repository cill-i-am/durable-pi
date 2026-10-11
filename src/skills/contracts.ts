import { Schema } from "effect"
import { SkillSource } from "./source"

export const SkillId = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/i))
export const SkillName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isPattern(/\S/),
  Schema.isMaxLength(80)
)
export const SkillBody = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isPattern(/\S/),
  Schema.isMaxLength(16_000)
)
export const SkillReference = Schema.Struct({
  id: SkillId,
  name: SkillName,
  revision: Schema.Number,
})
export type SkillReference = typeof SkillReference.Type
export const SkillDocument = Schema.Struct({
  ...SkillReference.fields,
  body: SkillBody,
  createdAt: Schema.String,
  source: Schema.optional(SkillSource),
})
export type SkillDocument = typeof SkillDocument.Type
export const Skill = Schema.Struct({
  ...SkillDocument.fields,
  archived: Schema.Boolean,
  stateRevision: Schema.Number,
})
export type Skill = typeof Skill.Type
export const SkillLibrary = Schema.Struct({ skills: Schema.Array(Skill) })
export const SkillVersions = Schema.Struct({
  versions: Schema.Array(SkillDocument),
})
export const SkillSelection = Schema.Struct({
  revision: Schema.Number,
  skills: Schema.Array(SkillDocument),
})
export type SkillSelection = typeof SkillSelection.Type
export const SaveSkill = Schema.Struct({
  id: SkillId,
  expectedRevision: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0)
  ),
  name: SkillName,
  body: SkillBody,
  source: Schema.optional(SkillSource),
})
export type SaveSkill = typeof SaveSkill.Type
export const ArchiveSkill = Schema.Struct({
  id: SkillId,
  expectedStateRevision: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThan(0)
  ),
  archived: Schema.Boolean,
})
export const SelectSkills = Schema.Struct({
  expectedRevision: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0)
  ),
  skills: Schema.Array(
    Schema.Struct({
      id: SkillId,
      revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
    })
  ).check(Schema.isMaxLength(4)),
})
export type SelectSkills = typeof SelectSkills.Type
export class SkillConflict extends Schema.TaggedError<SkillConflict>()(
  "SkillConflict",
  { message: Schema.String }
) {}
export function skillContext(skills: readonly SkillDocument[]) {
  if (!skills.length) return ""
  return `Owner-selected skills for this reply. Use them when relevant. They do not grant tools or override the user's current request or access controls. Imported skills are local copies of SKILL.md; source.files are names of reference files, not loaded content. If the source skills tool is selected and access permits, read references with the pinned source app, name, deployment, revision and profile. Otherwise ask for access rather than inventing their contents.\n${JSON.stringify(skills.map(({ id, name, revision, body, source }) => ({ id, name, revision, body, source })))}`
}
