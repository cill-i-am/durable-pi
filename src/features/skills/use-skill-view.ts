import { createEffectActor, send, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber } from "effect"
import { useEffect, useState } from "react"
import type { EventFromLogic, SnapshotFrom } from "xstate"

import { nativeOperation } from "@/shared/interop"

import { skillViewMachine, type SkillDraft } from "./skill-view.machine"
import { skillVersions, skillWorkFailures } from "./skills-owner"

export const readSkillFile = (file: File, id: string) =>
  nativeOperation(
    () => file.text(),
    (cause) => cause
  ).pipe(
    Effect.flatMap((body) =>
      body.length > 16000 || !body.trim()
        ? Effect.fail(new Error("Use 1 to 16,000 characters."))
        : Effect.succeed({
            id,
            expectedRevision: 0,
            name: file.name.replace(/\.(md|txt)$/i, "").slice(0, 80),
            body,
          })
    )
  )
type Machine = ReturnType<typeof skillViewMachine>
export function useSkillView() {
  const [actor, setActor] = useState<EffectActor<Machine> | null>(null),
    [snapshot, setSnapshot] = useState<SnapshotFrom<Machine> | null>(null),
    [draft, setDraft] = useState<SkillDraft | null>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const observe = yield* skillWorkFailures
        const owner = yield* createEffectActor(
          skillViewMachine({
            file: (file, id) => observe(readSkillFile(file, id)),
            versions: (id) => observe(skillVersions(id)),
            draft: (value) =>
              Effect.sync(() => {
                if (mounted) setDraft(value)
              }),
          })
        )
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            owner.subscribe((value) => {
              if (mounted) setSnapshot(value)
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        if (mounted) {
          setActor(owner)
          setSnapshot(owner.getSnapshot())
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
  }, [])
  const event = (value: EventFromLogic<Machine>) => {
    if (actor) Effect.runFork(send(actor, value))
  }
  return {
    draft: snapshot?.matches("editing") ? draft : null,
    setFields: setDraft,
    event,
    error: snapshot?.context.error ?? "",
    generation: snapshot?.context.generation ?? 0,
    importing: snapshot?.matches("readingFile") ?? false,
    hosted: snapshot?.matches("hosted") ?? false,
    historyBusy: snapshot?.matches("readingHistory") ?? false,
    history:
      snapshot?.matches("history") && snapshot.context.skill
        ? { skill: snapshot.context.skill, versions: snapshot.context.versions }
        : null,
  }
}
