import { Schema, Effect } from "effect"
import type { SkillError, SkillSelectionRepository } from "./repository"
import {
  SkillConflict,
  type SkillDocument,
  type SelectSkills,
} from "./contracts"

export type SkillResolution = { skills: SkillDocument[]; error: string | null }
export const selectBotSkills = (
  store: SkillSelectionRepository,
  input: SelectSkills,
  resolve: (
    references: SelectSkills["skills"]
  ) => Effect.Effect<SkillResolution, SkillError>,
  canWrite: () => Effect.Effect<boolean, SkillError>
) =>
  Effect.gen(function* () {
    if (
      new Set(input.skills.map((skill) => skill.id)).size !==
      input.skills.length
    )
      return yield* new SkillConflict({ message: "Select each skill once." })
    const current = yield* store.selection()
    const retained = (ref: { id: string; revision: number }) =>
      current.skills.find(
        (skill) => skill.id === ref.id && skill.revision === ref.revision
      )
    const needed = input.skills.filter((ref) => !retained(ref))
    const result = needed.length
      ? yield* resolve(needed)
      : { skills: [], error: null }
    if (result.error) return yield* new SkillConflict({ message: result.error })
    if (!(yield* canWrite()))
      return yield* new SkillConflict({
        message: "Restore this bot before changing its skills.",
      })
    const selected = yield* Effect.try({
      try: () => {
        const documents = input.skills.map((ref) => {
          const skill =
            retained(ref) ??
            result.skills.find(
              (candidate) =>
                candidate.id === ref.id && candidate.revision === ref.revision
            )
          if (!skill)
            throw new SkillConflict({
              message: "A selected skill could not be loaded.",
            })
          return skill
        })
        return documents
      },
      catch: (cause) => {
        const skillConflict = Schema.decodeUnknownOption(SkillConflict)(cause)
        if (skillConflict._tag === "Some") return skillConflict.value
        throw cause
      },
    })
    return yield* store.select(input.expectedRevision, selected, canWrite)
  }).pipe(Effect.withSpan("Skills.selectBotSkills"))
