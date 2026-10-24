import { createEffectActor, send, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber } from "effect"
import { useEffect, useRef, useState } from "react"
import type { SnapshotFrom } from "xstate"

import type { BrowserState } from "@/browser/contracts"
import { agentUrl } from "@/http/client"

import {
  browserPreviewMachine,
  sameBrowserPreview,
} from "./browser-preview.machine"

type Machine = ReturnType<typeof browserPreviewMachine>
export function useBrowserPreview(
  agentId: string,
  state: BrowserState,
  refresh: () => void
) {
  const view = {
    agentId,
    generation: state.policy.generation,
    version: state.version,
    hasScreenshot: state.hasScreenshot,
  }
  const latest = useRef({ view, refresh })
  useEffect(() => {
    latest.current = { view, refresh }
  })
  const [actor, setActor] = useState<EffectActor<Machine> | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<Machine> | null>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const owned = yield* createEffectActor(
          browserPreviewMachine(() =>
            Effect.sync(() => latest.current.refresh())
          ),
          { input: latest.current.view }
        )
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
  }, [])
  useEffect(() => {
    if (actor)
      Effect.runFork(
        send(actor, {
          type: "VIEW",
          agentId,
          generation: state.policy.generation,
          version: state.version,
          hasScreenshot: state.hasScreenshot,
        })
      )
  }, [
    actor,
    agentId,
    state.policy.generation,
    state.version,
    state.hasScreenshot,
  ])
  const current =
    snapshot && sameBrowserPreview(snapshot.context, view) ? snapshot : null
  return {
    active: !!current,
    ready: current?.matches("ready") === true,
    failed: current?.matches("failed") === true,
    key: JSON.stringify([agentId, view.generation, view.version]),
    src: `${agentUrl(agentId, "browser/screenshot")}&version=${view.version}&generation=${view.generation}`,
    loaded: () => {
      if (actor) Effect.runFork(send(actor, { type: "LOADED", ...view }))
    },
    failedToLoad: () => {
      if (actor) Effect.runFork(send(actor, { type: "FAILED", ...view }))
    },
  }
}

export function BrowserScreenshot({
  agentId,
  state,
  refresh,
  alt,
}: {
  agentId: string
  state: BrowserState
  refresh: () => void
  alt: string
}) {
  const preview = useBrowserPreview(agentId, state, refresh)
  return preview.active && state.hasScreenshot && !preview.failed ? (
    <img
      key={preview.key}
      src={preview.src}
      onLoad={preview.loaded}
      onError={preview.failedToLoad}
      alt={alt}
      className="w-full rounded-md border bg-white"
    />
  ) : null
}
