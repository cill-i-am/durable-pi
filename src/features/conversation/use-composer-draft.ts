import { useCallback, useEffect, useRef, useState } from "react"

import { useFiles } from "@/features/files/use-files"
import { useReloadGuard } from "@/features/updates/update-recovery"

import { emptyDraft, readDraft, writeDraft, type ComposerDraft } from "./draft"

export function useComposerDraft(ownerId: string, agentId: string) {
  const [value, setValue] = useState<ComposerDraft>(() => {
    try {
      return readDraft(sessionStorage, ownerId, agentId)
    } catch {
      return emptyDraft()
    }
  })
  const current = useRef(value)
  const [unsaved, setUnsaved] = useState(false)
  const update = useCallback(
    (
      change:
        | Partial<ComposerDraft>
        | ((draft: ComposerDraft) => Partial<ComposerDraft>)
    ) => {
      const next = {
        ...current.current,
        ...(typeof change === "function" ? change(current.current) : change),
      }
      current.current = next
      setValue(next)
      try {
        writeDraft(sessionStorage, ownerId, agentId, next)
        setUnsaved(false)
      } catch {
        setUnsaved(!!next.text || !!next.files.length || !!next.attempt)
      }
    },
    [ownerId, agentId]
  )
  return { value, update, unsaved }
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
    update({ files: selected })
  }, [selected, update])
  const restoreFiles = useRef(composerDraft.value.files.length > 0)
  useEffect(() => {
    if (restoreFiles.current) {
      restoreFiles.current = false
      void refresh()
    }
  }, [refresh])
  useReloadGuard(
    "Your draft could not be saved in this tab. Copy it before reloading.",
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
