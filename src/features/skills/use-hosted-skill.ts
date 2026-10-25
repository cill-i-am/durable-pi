import { createEffectActor, send, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber } from "effect"
import { useEffect, useRef, useState } from "react"
import type { EventFromLogic, SnapshotFrom } from "xstate"

import type { SaveSkill } from "@/skills/contracts"

import { hostedSkillRequests } from "./hosted-skill-owner"
import { hostedSkillMachine } from "./hosted-skill.machine"
import { skillWorkFailures } from "./skills-owner"

type Machine = ReturnType<typeof hostedSkillMachine>
export function useHostedSkill(onPreview: (draft: SaveSkill) => void) {
  const preview = useRef(onPreview)
  useEffect(() => {
    preview.current = onPreview
  }, [onPreview])
  const [actor, setActor] = useState<EffectActor<Machine> | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<Machine> | null>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const observe = yield* skillWorkFailures
        const owner = yield* createEffectActor(
          hostedSkillMachine({
            providers: () => observe(hostedSkillRequests.providers()),
            browse: (input) => observe(hostedSkillRequests.browse(input)),
            read: (input) => observe(hostedSkillRequests.read(input)),
          })
        )
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            owner.on("preview", (event) => {
              if (mounted) preview.current(event.draft)
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
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
    providers: snapshot?.context.providers ?? [],
    selected: snapshot?.context.selected ?? "",
    catalog: snapshot?.context.catalog ?? null,
    error: snapshot?.context.error ?? "",
    busy: !snapshot || !snapshot.matches("ready"),
    event,
  }
}
