import { Effect } from "effect"
import type { SkillStore } from "./adapters/sqlite"
import {
  SkillConflict,
  type SkillDocument,
  type SelectSkills,
} from "./contracts"

export type SkillResolution = { skills: SkillDocument[]; error: string | null }
export const selectBotSkills = (
  store: SkillStore,
  input: SelectSkills,
  resolve: (references: SelectSkills["skills"]) => Promise<SkillResolution>,
  canWrite: () => boolean
) =>
  Effect.gen(function* () {
    if (
      new Set(input.skills.map((skill) => skill.id)).size !==
      input.skills.length
    )
      return yield* new SkillConflict({ message: "Select each skill once." })
    const current = yield* Effect.try(() => store.selection())
    const retained = (ref: { id: string; revision: number }) =>
      current.skills.find(
        (skill) => skill.id === ref.id && skill.revision === ref.revision
      )
    const needed = input.skills.filter((ref) => !retained(ref))
    const result = needed.length
      ? yield* Effect.tryPromise(() => resolve(needed))
      : { skills: [], error: null }
    if (result.error) return yield* new SkillConflict({ message: result.error })
    return yield* Effect.try({
      try: () => {
        if (!canWrite())
          throw new SkillConflict({
            message: "Restore this bot before changing its skills.",
          })
        const selected = input.skills.map((ref) => {
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
        return store.select(input.expectedRevision, selected)
      },
      catch: (cause) => cause,
    })
  })
