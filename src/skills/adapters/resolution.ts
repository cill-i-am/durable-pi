import { Effect } from "effect"

import { preserveFatal } from "../../shared/effect"
import type { SkillError } from "../repository"
import type { SkillResolution } from "../selection"

export const skillResolution = <TRequirements>(
  work: Effect.Effect<SkillResolution["skills"], SkillError, TRequirements>
): Effect.Effect<SkillResolution, never, TRequirements> =>
  work.pipe(
    Effect.map((skills) => ({ skills, error: null })),
    preserveFatal,
    Effect.catchTags({
      SkillConflict: (error) =>
        Effect.succeed({ skills: [], error: error.message }),
      SkillStorageError: () =>
        Effect.succeed({ skills: [], error: "Could not load these skills." }),
    })
  )
