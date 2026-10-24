import { createEffectActor, send, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber } from "effect"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type { SnapshotFrom } from "xstate"

import { nativeOperation } from "@/shared/interop"

import {
  fileDetailsMachine,
  type FileDetailAction,
} from "./file-details.machine"
import { fileWorkFailures } from "./owned-work"

type Machine = ReturnType<typeof fileDetailsMachine>
export function useFileDetails(
  name: string,
  mutate: (action: FileDetailAction, name: string) => Promise<boolean>
) {
  const mutation = useRef(mutate)
  useLayoutEffect(() => {
    mutation.current = mutate
  }, [mutate])
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
            fileDetailsMachine((input) =>
              observe(
                nativeOperation(
                  () => mutation.current(input.action, input.name),
                  (cause) => cause
                )
              )
            ),
            { input: { name } }
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
    // The parent keys this owner by agent and file; EDIT supplies the latest name.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [])
  const busy = snapshot?.matches("submitting") ?? false
  return {
    name: snapshot?.context.name ?? name,
    busy: busy || !actor,
    editing:
      snapshot?.matches("editing") ||
      (busy && snapshot?.context.origin === "editing"),
    failed: !!snapshot?.context.failure,
    edit: () => {
      if (actor) Effect.runFork(send(actor, { type: "EDIT", name }))
    },
    change: (name: string) => {
      if (actor) Effect.runFork(send(actor, { type: "NAME", name }))
    },
    cancel: () => {
      if (actor) Effect.runFork(send(actor, { type: "CANCEL" }))
    },
    submit: (action: FileDetailAction) => {
      if (actor) Effect.runFork(send(actor, { type: "SUBMIT", action }))
    },
  }
}
