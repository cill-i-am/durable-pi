import { useCallback, useEffect, useRef, useState } from "react"
import { Schema } from "effect"
import { agentApi } from "@/http/client"
import { FileInfo, FileList, MAX_ATTACHMENTS } from "@/workspace/files"
import { pollFiles } from "./poll"
import { attachmentReady, preparingFile } from "./preparation"
import { uploadFile, type UploadAttempt } from "./uploads"

export function useFiles(agentId: string) {
  const [files, setFiles] = useState<readonly FileInfo[]>([])
  const [selected, setSelected] = useState<readonly FileInfo[]>([])
  const [uploads, setUploads] = useState<UploadAttempt[]>([])
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [processing, setProcessing] = useState(false)
  const revision = useRef(0)
  const busy = useRef(false)
  const api = agentApi(agentId)
  const refresh = useCallback(async () => {
    const expected = ++revision.current
    setLoading(true)
    try {
      const result = Schema.decodeUnknownSync(FileList)(
        await agentApi(agentId)("files")
      )
      if (expected === revision.current) {
        setFiles(result.files)
        setSelected((current) =>
          current.map(
            (file) => result.files.find((saved) => saved.id === file.id) ?? file
          )
        )
        setError("")
      }
    } catch (cause) {
      if (expected === revision.current)
        setError(
          cause instanceof Error ? cause.message : "Could not load files."
        )
    } finally {
      if (expected === revision.current) setLoading(false)
    }
  }, [agentId])
  const extracting = files.some(preparingFile)
  useEffect(() => {
    if (!extracting) return
    return pollFiles(refresh)
  }, [extracting, refresh])
  function select(file: FileInfo) {
    setSelected((current) =>
      current.some((item) => item.id === file.id)
        ? current
        : current.length >= MAX_ATTACHMENTS
          ? current
          : [...current, file]
    )
  }
  async function runUpload(attempt: UploadAttempt) {
    setUploads((current) => [
      ...current.filter((item) => item.id !== attempt.id),
      { ...attempt, status: "uploading" },
    ])
    try {
      const file = await uploadFile(agentId, attempt)
      revision.current++
      setLoading(false)
      setFiles((current) => [
        file,
        ...current.filter((item) => item.id !== file.id),
      ])
      if (attempt.attach) select(file)
      setUploads((current) => current.filter((item) => item.id !== attempt.id))
      await refresh()
    } catch (cause) {
      setUploads((current) =>
        current.map((item) =>
          item.id === attempt.id
            ? {
                ...attempt,
                status: "failed",
                error:
                  cause instanceof Error
                    ? cause.message
                    : "Upload interrupted. Retry.",
              }
            : item
        )
      )
    }
  }
  async function upload(chosen: readonly File[], attach: boolean) {
    if (busy.current) return
    const capacity = attach
      ? MAX_ATTACHMENTS - selected.length
      : MAX_ATTACHMENTS
    if (chosen.length > capacity) {
      setError(`Choose up to ${capacity} more files.`)
      return
    }
    busy.current = true
    setProcessing(true)
    setError("")
    try {
      for (const file of chosen)
        await runUpload({
          attach,
          id:
            files.find(
              (saved) =>
                saved.status === "uploading" &&
                !saved.trashed &&
                saved.name === file.name &&
                saved.size === file.size
            )?.id ?? crypto.randomUUID(),
          file,
          status: "uploading",
        })
    } finally {
      busy.current = false
      setProcessing(false)
    }
  }
  async function retry(attempt: UploadAttempt) {
    if (busy.current) return
    if (attempt.attach && selected.length >= MAX_ATTACHMENTS) {
      setError("Remove a message attachment before retrying this upload.")
      return
    }
    busy.current = true
    setProcessing(true)
    try {
      await runUpload(attempt)
    } finally {
      busy.current = false
      setProcessing(false)
    }
  }
  async function mutate(
    id: string,
    action: "trash" | "restore" | "rename" | "extract",
    name?: string
  ) {
    try {
      const updated = Schema.decodeUnknownSync(FileInfo)(
        await api(`files/${id}/${action}`, { name })
      )
      revision.current++
      setLoading(false)
      setFiles((current) =>
        current.map((file) => (file.id === id ? updated : file))
      )
      setSelected((current) =>
        current.flatMap((file) =>
          file.id !== id ? [file] : updated.trashed ? [] : [updated]
        )
      )
      setError("")
      await refresh()
      return true
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not update this file."
      )
      return false
    }
  }
  return {
    agentId,
    files,
    selected,
    uploads,
    error,
    loading,
    refresh,
    select,
    upload,
    retry,
    mutate,
    uploading: processing,
    attachmentsReady: selected.every(attachmentReady),
    remove: (id: string) =>
      setSelected((current) => current.filter((file) => file.id !== id)),
    clear: (ids: readonly string[]) =>
      setSelected((current) =>
        current.filter((file) => !ids.includes(file.id))
      ),
    dismiss: (id: string) =>
      setUploads((current) => current.filter((item) => item.id !== id)),
  }
}
export type FilesState = ReturnType<typeof useFiles>
