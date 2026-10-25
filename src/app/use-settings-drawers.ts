import { createEffectActor } from "@xstate/effect"
import { Effect, Fiber } from "effect"
import { useEffect, useRef, useState } from "react"
import type { SnapshotFrom } from "xstate"

import type { SettingsFrame } from "@/navigation/settings-stack"

import {
  settingsDrawersMachine,
  settingsPrefix,
  type SettingsDrawerRoute,
} from "./settings-drawers.machine"

export function makeSettingsDrawers(
  initial: SettingsDrawerRoute,
  current: () => SettingsDrawerRoute
) {
  return Effect.gen(function* () {
    let active = true
    const actor = yield* createEffectActor(
      settingsDrawersMachine({
        navigate: (href, action) =>
          Effect.sync(() => {
            const latest = current()
            if (active && !latest.locked && latest.href === href) action()
          }),
      }),
      { input: initial }
    )
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        active = false
      })
    )
    return {
      actor,
      revoke: () => {
        active = false
      },
    }
  })
}

/** Retain outgoing native bodies and dispatch an exit only after root closure. */
export function useSettingsDrawers(
  frames: readonly SettingsFrame[],
  options: { href: string; locked: boolean }
) {
  const latest = useRef<SettingsDrawerRoute>({ ...options, frames })
  latest.current = { ...options, frames }
  const initial = useRef(latest.current)
  const owner = useRef<Effect.Success<
    ReturnType<typeof makeSettingsDrawers>
  > | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<
    ReturnType<typeof settingsDrawersMachine>
  > | null>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const value = yield* makeSettingsDrawers(
          initial.current,
          () => latest.current
        )
        owner.current = value
        value.actor.send({ type: "ROUTE", ...latest.current })
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            value.actor.subscribe((state) => {
              if (mounted) setSnapshot(state)
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        if (mounted) setSnapshot(value.actor.getSnapshot())
        return yield* Effect.never
      }).pipe(Effect.scoped)
    )
    return () => {
      mounted = false
      owner.current?.revoke()
      owner.current = null
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [])
  const signature = JSON.stringify(frames)
  useEffect(() => {
    owner.current?.actor.send({ type: "ROUTE", ...latest.current })
  }, [signature, options.href, options.locked])
  const rendered = snapshot?.context.rendered ?? initial.current.frames
  const desired =
    snapshot && !snapshot.matches("active")
      ? []
      : (snapshot?.context.route.frames ?? initial.current.frames)
  return {
    frames: rendered,
    depth: settingsPrefix(rendered, desired),
    exit: (action: () => void) =>
      owner.current?.actor.send({ type: "EXIT", action }),
    closed: (id: string) =>
      owner.current?.actor.send({
        type: "CLOSED",
        id,
        revision: snapshot?.context.revision ?? -1,
      }),
  }
}
