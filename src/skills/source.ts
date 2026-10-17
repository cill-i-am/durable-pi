import { Schema } from "effect"

import { ConnectionId } from "../access/connections"

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(160),
  Schema.isPattern(/^[a-zA-Z0-9_.-]+$/)
)
export const SkillApp = Schema.Struct({
  id: Identifier,
  slug: Identifier,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
})
export const HostedSkill = Schema.Struct({
  name: Identifier,
  description: Schema.String.check(Schema.isMaxLength(2000)),
  app: SkillApp,
  deployment: Identifier,
  revision: Identifier,
  profile: Schema.optional(Identifier),
  profileRevision: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
  ),
})
export type HostedSkill = typeof HostedSkill.Type
export const HostedSkillCatalog = Schema.Struct({
  skills: Schema.Array(HostedSkill).check(Schema.isMaxLength(100)),
})
export const SkillSource = Schema.Struct({
  ...HostedSkill.fields,
  connectionId: ConnectionId,
  connectionName: Schema.String.check(Schema.isMaxLength(80)),
  toolName: Schema.String.check(Schema.isPattern(/^mcp_[a-f0-9]{40}$/)),
  files: Schema.Array(Schema.String.check(Schema.isMaxLength(240))).check(
    Schema.isMaxLength(100)
  ),
}).check(
  Schema.makeFilter(
    (source) =>
      new TextEncoder().encode(JSON.stringify(source)).byteLength <= 16_000 ||
      "Skill source metadata must fit within 16 KB."
  )
)
export type SkillSource = typeof SkillSource.Type
export const BrowseHostedSkills = Schema.Struct({
  toolName: SkillSource.fields.toolName,
  app: Identifier,
})
export const ReadHostedSkill = Schema.Struct({
  toolName: SkillSource.fields.toolName,
  skill: HostedSkill,
})

export function hostedSkillQuery(skill: HostedSkill) {
  return {
    app: skill.app.id,
    name: skill.name,
    version: skill.deployment,
    revision: skill.revision,
    ...(skill.profile ? { profile: skill.profile } : {}),
    ...(skill.profileRevision
      ? { profileRevision: skill.profileRevision }
      : {}),
  }
}
