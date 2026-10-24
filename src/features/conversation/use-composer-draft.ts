import { Effect, Fiber } from "effect"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { SnapshotFrom } from "xstate"

import { useFiles } from "@/features/files/use-files"
import { useReloadGuard } from "@/features/updates/update-recovery"

import { makeComposerDraft } from "./composer-draft-owner"
import type { composerDraftMachine } from "./composer-draft.machine"
import { emptyDraft, readDraft, writeDraft, type ComposerDraft } from "./draft"

type DraftOwner = Effect.Success<ReturnType<typeof makeComposerDraft>>
type Snapshot = SnapshotFrom<ReturnType<typeof composerDraftMachine>>
export function useComposerDraft(ownerId: string, agentId: string) {
  const initial = useMemo(() => {
    try {
      return {
        draft: readDraft(sessionStorage, ownerId, agentId),
        unreadable: false,
      }
    } catch {
      return { draft: emptyDraft(), unreadable: true }
    }
  }, [ownerId, agentId])
  const owner = useRef<DraftOwner | null>(null)
  const [observed, setObserved] = useState<{
    initial: typeof initial
    snapshot: Snapshot
  } | null>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const current = yield* makeComposerDraft(initial, (draft) =>
          Effect.try({
            try: () => writeDraft(sessionStorage, ownerId, agentId, draft),
            catch: (cause) => cause,
          })
        )
        owner.current = current
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            current.actor.subscribe((snapshot) => {
              if (mounted) setObserved({ initial, snapshot })
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        if (mounted)
          setObserved({ initial, snapshot: current.actor.getSnapshot() })
        return yield* Effect.never
      }).pipe(Effect.scoped)
    )
    return () => {
      mounted = false
      owner.current = null
      Effect.runFork(
        Fiber.interrupt(fiber).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() =>
              console.error("Composer draft cleanup failed", cause)
            )
          )
        )
      )
    }
  }, [ownerId, agentId, initial])
  const update = useCallback(
    (
      change:
        | Partial<ComposerDraft>
        | ((draft: ComposerDraft) => Partial<ComposerDraft>)
    ) => {
      const current = owner.current
      return current
        ? Effect.runPromise(
            current.update(typeof change === "function" ? change : () => change)
          )
        : Promise.resolve(false)
    },
    []
  )
  const snapshot = observed?.initial === initial ? observed.snapshot : null
  return {
    value: snapshot?.context.draft ?? initial.draft,
    update,
    ready: !!snapshot,
    unreadable: snapshot?.matches("unreadable") ?? initial.unreadable,
    unsaved: snapshot ? !snapshot.matches("saved") : initial.unreadable,
  }
}
export type ComposerDraftState = ReturnType<typeof useComposerDraft>

/** Restore file references and coordinate local draft/upload fences together. */
export function useComposerWorkspace(
  ownerId: string,
  agentId: string,
  sending: boolean
) {
  const composerDraft = useComposerDraft(ownerId, agentId)
  const files = useFiles(agentId, composerDraft.value.files)
  const { selected, refresh } = files
  const { update } = composerDraft
  useEffect(() => {
    void update({ files: selected })
  }, [selected, update])
  const restoreFiles = useRef(composerDraft.value.files.length > 0)
  useEffect(() => {
    if (restoreFiles.current) {
      restoreFiles.current = false
      void refresh()
    }
  }, [refresh])
  useReloadGuard(
    composerDraft.unreadable
      ? "Your saved draft could not be read. Keep this tab open; its original data has been retained."
      : "Your draft could not be saved in this tab. Copy it before reloading.",
    composerDraft.unsaved
  )
  useReloadGuard(
    "Wait for the message submission to finish before reloading.",
    sending
  )
  useReloadGuard(
    "Finish, retry or dismiss the file upload before reloading.",
    files.uploading || files.uploads.length > 0
  )
  return { composerDraft, files }
}
