import { createEffectActor, send, type EffectActor } from "@xstate/effect"
import { Effect, Fiber } from "effect"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type { SnapshotFrom } from "xstate"

import { objectCreationMachine } from "./object-creation.machine"
import type { ObjectStore } from "./store"

export function useObjectCreation(
  store: ObjectStore,
  selected: string | null,
  onSelect: (id: string | null) => void
) {
  const [actor, setActor] = useState<EffectActor<
    typeof objectCreationMachine
  > | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<
    typeof objectCreationMachine
  > | null>(null)
  const current = useRef({ selected, onSelect })
  useLayoutEffect(() => {
    current.current = { selected, onSelect }
    if (actor) Effect.runFork(send(actor, { type: "VIEW", selected }))
  }, [selected, onSelect, actor])
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const owner = yield* createEffectActor(objectCreationMachine, {
          input: current.current.selected,
        })
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            owner.subscribe((value) => {
              if (mounted) setSnapshot(value)
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            owner.on("selected", (event) => {
              if (mounted && current.current.selected === null)
                current.current.onSelect(event.id)
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        const update = () => {
          const id = owner.getSnapshot().context.id
          if (id) {
            const state = store.getSnapshot()
            Effect.runFork(
              send(owner, {
                type: "STATUS",
                id,
                pending: !!state.pending[id],
                saved: !!state.saved[id],
              })
            )
          }
        }
        yield* Effect.acquireRelease(
          Effect.sync(() => store.subscribe(update)),
          (unsubscribe) => Effect.sync(unsubscribe)
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
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [store])
  return {
    id: snapshot?.context.id ?? null,
    begin: () => {
      if (actor)
        Effect.runFork(send(actor, { type: "BEGIN", id: crypto.randomUUID() }))
    },
    cancel: () => {
      if (actor) Effect.runFork(send(actor, { type: "CANCEL" }))
    },
  }
}
