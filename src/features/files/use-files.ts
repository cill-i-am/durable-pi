import { Cause, Effect, Exit, Fiber } from "effect"
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react"

import type { FileInfo } from "@/workspace/files"

import { makeFilesCache } from "./file-cache"
import type { FileAction, UploadAttempt } from "./file-types"
import { makeFilesOwner, type FilesOwner } from "./files-owner"
import { attachmentSelectable } from "./preparation"

export function useFiles(
  agentId: string,
  initialSelection: readonly FileInfo[] = []
) {
  // Initial draft references restore once for this agent. Owner changes remount
  // the workspace; changing the agent creates a disjoint pure-data cache.
  // oxlint-disable-next-line react/exhaustive-deps
  const cache = useMemo(() => makeFilesCache(initialSelection), [agentId])
  const data = useSyncExternalStore(cache.subscribe, cache.read, cache.read)
  const [live, setLive] = useState<{
    owner: FilesOwner
    view: ReturnType<FilesOwner["read"]>
  } | null>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const owner = yield* makeFilesOwner(agentId, cache)
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            owner.subscribe(() => {
              if (mounted) setLive({ owner, view: owner.read() })
            })
          ),
          (unsubscribe) => Effect.sync(unsubscribe)
        )
        if (mounted) setLive({ owner, view: owner.read() })
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
  }, [agentId, cache])
  const owner = live?.owner.cache === cache ? live.owner : null
  const view = owner ? live!.view : null
  const refresh = useCallback(
    () => (owner ? Effect.runPromise(owner.refresh()) : Promise.resolve()),
    [owner]
  )
  return {
    agentId,
    ...data,
    uploads: view?.uploads ?? [],
    error: view?.error ?? "",
    loading: view?.loading ?? true,
    uploading: view?.uploading ?? false,
    attachmentsReady: data.selected.every(attachmentSelectable),
    refresh,
    select: cache.select,
    upload: (chosen: readonly File[], attach: boolean) =>
      owner
        ? Effect.runPromise(owner.upload(chosen, attach))
        : Promise.resolve(),
    retry: (attempt: UploadAttempt) =>
      owner ? Effect.runPromise(owner.retry(attempt)) : Promise.resolve(),
    mutate: (id: string, action: FileAction, name?: string) =>
      owner
        ? Effect.runPromise(owner.mutate(id, action, name))
        : Promise.resolve(false),
    remove: (id: string) => cache.remove([id]),
    clear: cache.remove,
    dismiss: (id: string) => {
      if (owner) Effect.runFork(owner.dismiss(id))
    },
  }
}
export type FilesState = ReturnType<typeof useFiles>
