import { send, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber } from "effect"
import { useCallback, useEffect, useState } from "react"
import type { SnapshotFrom } from "xstate"

import type { SaveSkill, Skill, SkillDocument } from "@/skills/contracts"

import { makeSkillsOwner, skillCommand, skillsRequests } from "./skills-owner"
import { skillsMachine, type SkillCommand } from "./skills.machine"

type Machine = ReturnType<typeof skillsMachine>
export function useSkills(agentId?: string) {
  const [actor, setActor] = useState<EffectActor<Machine> | null>(null),
    [snapshot, setSnapshot] = useState<SnapshotFrom<Machine> | null>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const owned = yield* makeSkillsOwner(agentId, skillsRequests(agentId))
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            owned.subscribe((value) => {
              if (mounted) setSnapshot(value)
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        if (mounted) {
          setActor(owned)
          setSnapshot(owned.getSnapshot())
        }
        return yield* Effect.never
      }).pipe(Effect.scoped)
    )
    return () => {
      mounted = false
      Effect.runFork(
        Fiber.interrupt(fiber).pipe(
          Effect.andThen(Fiber.await(fiber)),
          Effect.flatMap((exit) =>
            Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
              ? Effect.logError(exit.cause)
              : Effect.void
          )
        )
      )
    }
  }, [agentId])
  const current = snapshot?.context.agentId === agentId ? snapshot : null,
    owner = actor?.getSnapshot().context.agentId === agentId ? actor : null
  const refresh = useCallback(
    () =>
      owner
        ? Effect.runPromise(send(owner, { type: "REFRESH" }))
        : Promise.resolve(),
    [owner]
  )
  const command = (input: SkillCommand) =>
    owner
      ? Effect.runPromise(skillCommand(owner, input))
      : Promise.resolve(undefined)
  return {
    library: current?.context.library ?? [],
    selection: current?.context.selection ?? { revision: 0, skills: [] },
    error: current?.context.error ?? "",
    loading: !!current?.matches({ resource: "loading" }),
    busy: !!current?.matches({ command: "requesting" }),
    ready: current?.context.ready ?? false,
    refresh,
    failed: current?.context.failed ?? null,
    retry: () =>
      current?.context.failed
        ? command(current.context.failed)
        : Promise.resolve(undefined),
    save: async (input: SaveSkill) => {
      const result = await command({ kind: "save", input })
      return result && "id" in result ? result : undefined
    },
    archive: (skill: Skill) =>
      command({
        kind: "archive",
        input: {
          id: skill.id,
          expectedStateRevision: skill.stateRevision,
          archived: !skill.archived,
        },
      }),
    select: (skills: readonly Pick<SkillDocument, "id" | "revision">[]) =>
      command({
        kind: "select",
        input: {
          expectedRevision: current?.context.selection.revision ?? 0,
          skills,
        },
      }),
  }
}
export type SkillsState = ReturnType<typeof useSkills>
