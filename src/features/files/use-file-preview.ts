import { createEffectActor, send, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber } from "effect"
import { useEffect, useState } from "react"
import type { SnapshotFrom } from "xstate"

import { readFilePreview } from "./file-preview-resource"
import {
  filePreviewMachine,
  type PreviewResource,
} from "./file-preview.machine"
import { fileWorkFailures } from "./owned-work"

type Machine = ReturnType<typeof filePreviewMachine>
/** One mounted preview owns its requests, including aborted requests settling late. */
export function useFilePreview(resource: PreviewResource) {
  const { key, agentId, fileId, kind, eager } = resource
  const [actor, setActor] = useState<EffectActor<Machine> | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<Machine> | null>(null)
  useEffect(() => {
    let mounted = true
    let reported: Cause.Cause<unknown> | null = null
    const owner = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const observe = yield* fileWorkFailures
          const owned = yield* createEffectActor(
            filePreviewMachine((input) => observe(readFilePreview(input))),
            { input: resource }
          )
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              owned.subscribe((value) => {
                if (mounted) setSnapshot(value)
                const failure = value.context.failure
                if (failure && failure !== reported && Cause.hasDies(failure)) {
                  reported = failure
                  Effect.runFork(Effect.logError(failure))
                }
              })
            ),
            (subscription) => Effect.sync(() => subscription.unsubscribe())
          )
          if (mounted) {
            setActor(owned)
            setSnapshot(owned.getSnapshot())
          }
          return yield* Effect.never
        })
      )
    )
    return () => {
      mounted = false
      Effect.runFork(
        Fiber.interrupt(owner).pipe(
          Effect.andThen(Fiber.await(owner)),
          Effect.flatMap((exit) =>
            Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
              ? Effect.logError(exit.cause)
              : Effect.void
          )
        )
      )
    }
    // Resource changes are fenced machine events, not independent request owners.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [])
  useEffect(() => {
    if (actor)
      Effect.runFork(
        send(actor, { type: "RESOURCE", key, agentId, fileId, kind, eager })
      )
  }, [actor, key, agentId, fileId, kind, eager])
  const current =
    snapshot?.context.resource.key === resource.key ? snapshot : null
  return {
    value: current?.context.value ?? null,
    failed: !!current?.context.failure,
    loaded: current?.matches("ready") ?? false,
    toggle: (open: boolean) => {
      if (actor) Effect.runFork(send(actor, { type: open ? "OPEN" : "CLOSE" }))
    },
  }
}
