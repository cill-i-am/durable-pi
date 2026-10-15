import {
  SkillConflict,
  type Skill,
  type SaveSkill,
  type SkillDocument,
  type SkillSelection,
  type SelectSkills,
} from "./contracts"

export function saveSkill(
  input: SaveSkill,
  current: Skill | undefined,
  total: number,
  createdAt: string
): Skill {
  if (current?.archived)
    throw new SkillConflict({
      message: "Restore this skill before editing it.",
    })
  if (
    current &&
    current.name === input.name &&
    current.body === input.body &&
    JSON.stringify(current.source) === JSON.stringify(input.source) &&
    (input.expectedRevision === current.revision ||
      input.expectedRevision === current.revision - 1)
  )
    return current
  if ((current?.revision ?? 0) !== input.expectedRevision)
    throw new SkillConflict({
      message: "This skill changed in another window. Reload before saving.",
    })
  if (!current && total >= 100)
    throw new SkillConflict({
      message: "The library supports up to 100 skills.",
    })
  if ((current?.revision ?? 0) >= 100)
    throw new SkillConflict({
      message:
        "This skill has reached its 100-revision limit. Create a new skill to continue.",
    })
  return {
    id: input.id,
    name: input.name,
    body: input.body,
    revision: input.expectedRevision + 1,
    createdAt,
    archived: false,
    stateRevision: (current?.stateRevision ?? 0) + 1,
    ...(input.source ? { source: input.source } : {}),
  }
}

export function archiveSkill(
  current: Skill | undefined,
  expected: number,
  archived: boolean
): Skill {
  if (
    current &&
    current.stateRevision === expected + 1 &&
    current.archived === archived
  )
    return current
  if (!current || current.stateRevision !== expected)
    throw new SkillConflict({
      message: "This skill changed. Reload the library.",
    })
  return current.archived === archived
    ? current
    : { ...current, archived, stateRevision: current.stateRevision + 1 }
}

export function selectSkills(
  current: SkillSelection,
  expected: number,
  skills: readonly SkillDocument[]
): SkillSelection {
  if (JSON.stringify(current.skills) === JSON.stringify(skills)) return current
  if (current.revision !== expected)
    throw new SkillConflict({
      message: "This bot's skills changed. Reload before selecting again.",
    })
  return { revision: current.revision + 1, skills: [...skills] }
}

export function uniqueReferences(references: SelectSkills["skills"]) {
  if (new Set(references.map((value) => value.id)).size !== references.length)
    throw new SkillConflict({ message: "Select each skill once." })
}

export function requireAvailableSkill(library: readonly Skill[], id: string) {
  if (!library.some((skill) => skill.id === id && !skill.archived))
    throw new SkillConflict({
      message:
        "A selected skill is archived or unavailable. Reload the library.",
    })
}
