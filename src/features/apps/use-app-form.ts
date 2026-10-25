import { createEffectActor, send, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber } from "effect"
import { useEffect, useRef, useState } from "react"
import type { SnapshotFrom } from "xstate"

import type { AppAction } from "@/apps/contracts"
import { nativeOperation } from "@/shared/interop"

import { appFormMachine } from "./app-form.machine"
import { appWorkFailures } from "./app-owner"

type Actor = EffectActor<ReturnType<typeof appFormMachine>>
export function useAppForm(
  blockId: string,
  saved: Record<string, string>,
  revision: number,
  disabled: boolean,
  onAction: (action: AppAction, revision?: number) => Promise<boolean>
) {
  const current = useRef({ saved, revision, disabled, onAction })
  current.current = { saved, revision, disabled, onAction }
  const [actor, setActor] = useState<Actor | null>(null),
    [snapshot, setSnapshot] = useState<SnapshotFrom<
      ReturnType<typeof appFormMachine>
    > | null>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const observe = yield* appWorkFailures
        const owned = yield* createEffectActor(
          appFormMachine((request) =>
            observe(
              nativeOperation(
                () =>
                  current.current.disabled ||
                  current.current.revision !== request.revision
                    ? Promise.resolve(false)
                    : current.current.onAction(
                        { type: "submit", blockId, values: request.values },
                        request.revision
                      ),
                (cause) => cause
              )
            )
          ),
          { input: current.current }
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
  }, [blockId])
  useEffect(() => {
    if (actor)
      Effect.runFork(send(actor, { type: "SYNC", saved, revision, disabled }))
  }, [actor, saved, revision, disabled])
  const draft = snapshot?.context.draft
  return {
    values: draft?.values ?? saved,
    conflict: !!draft && draft.revision !== revision,
    submitted: snapshot?.context.submitted ?? false,
    saving: snapshot?.matches("saving") ?? false,
    submit: () => actor && Effect.runFork(send(actor, { type: "SUBMIT" })),
    edit: (field: string, value: string) =>
      actor && Effect.runFork(send(actor, { type: "EDIT", field, value })),
    useSaved: () => actor && Effect.runFork(send(actor, { type: "USE_SAVED" })),
    keepEdits: () =>
      actor && Effect.runFork(send(actor, { type: "KEEP_EDITS" })),
  }
}
