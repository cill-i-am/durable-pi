import { useCallback, useRef, useState } from "react"
import { Schema } from "effect"
import { agentApi } from "@/http/client"
import {
  Skill,
  SkillLibrary,
  SkillSelection,
  SkillVersions,
  type SaveSkill,
  type SkillDocument,
} from "@/skills/contracts"

export function useSkills(agentId: string) {
  const [library, setLibrary] = useState<readonly Skill[]>([])
  const [selection, setSelection] = useState<SkillSelection>({
    revision: 0,
    skills: [],
  })
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const sequence = useRef(0),
    locked = useRef(false)
  const refresh = useCallback(async () => {
    if (locked.current) return
    const revision = ++sequence.current
    setLoading(true)
    try {
      const [loadedLibrary, loadedSelection] = await Promise.all([
        agentApi("home")("skills").then(Schema.decodeUnknownSync(SkillLibrary)),
        agentApi(agentId)("skill-selection").then(
          Schema.decodeUnknownSync(SkillSelection)
        ),
      ])
      if (revision !== sequence.current) return
      setLibrary(loadedLibrary.skills)
      setSelection(loadedSelection)
      setReady(true)
      setError("")
    } catch (cause) {
      if (revision === sequence.current)
        setError(
          cause instanceof Error ? cause.message : "Could not load skills."
        )
    } finally {
      if (revision === sequence.current) setLoading(false)
    }
  }, [agentId])
  async function mutate<T>(work: () => Promise<T>, apply: (value: T) => void) {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError("")
    sequence.current++
    setLoading(false)
    try {
      const result = await work()
      sequence.current++
      setLoading(false)
      apply(result)
      return result
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not update skills."
      )
      return undefined
    } finally {
      locked.current = false
      setBusy(false)
    }
  }
  const put = (skill: Skill) =>
    setLibrary((current) => [
      skill,
      ...current.filter((value) => value.id !== skill.id),
    ])
  return {
    library,
    selection,
    error,
    loading,
    busy,
    ready,
    refresh,
    save: (input: SaveSkill) =>
      mutate(
        () =>
          agentApi("home")("skills/save", input).then(
            Schema.decodeUnknownSync(Skill)
          ),
        put
      ),
    archive: (skill: Skill) =>
      mutate(
        () =>
          agentApi("home")("skills/archive", {
            id: skill.id,
            expectedStateRevision: skill.stateRevision,
            archived: !skill.archived,
          }).then(Schema.decodeUnknownSync(Skill)),
        put
      ),
    select: (skills: readonly Pick<SkillDocument, "id" | "revision">[]) =>
      mutate(
        () =>
          agentApi(agentId)("skill-selection", {
            expectedRevision: selection.revision,
            skills,
          }).then(Schema.decodeUnknownSync(SkillSelection)),
        setSelection
      ),
    versions: (id: string) =>
      agentApi("home")(`skills/${id}`).then(
        Schema.decodeUnknownSync(SkillVersions)
      ),
  }
}
export type SkillsState = ReturnType<typeof useSkills>
