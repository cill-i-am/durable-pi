import type { FileInfo } from "@/workspace/files"

export const preparingFile = (file: FileInfo) =>
  !file.trashed &&
  file.status === "ready" &&
  (file.extraction?.status === "pending" ||
    file.extraction?.status === "running")
export const legacyPdf = (file: FileInfo) =>
  file.kind === "document" &&
  file.mime === "application/octet-stream" &&
  /\.pdf$/i.test(file.name)
export const attachmentReady = (file: FileInfo) =>
  !file.trashed &&
  file.status === "ready" &&
  (file.mime !== "application/pdf" || file.extraction?.status === "ready")
export function fileDescription(file: FileInfo) {
  const state = file.extraction
  if (!state)
    return file.kind === "video" || file.kind === "document"
      ? "Stored only"
      : file.kind
  if (
    file.trashed &&
    (state.status === "pending" || state.status === "running")
  )
    return "PDF · Extraction paused until restored"
  if (preparingFile(file)) return "PDF · Extracting text…"
  if (state.status === "ready")
    return `PDF · ${state.readPages} of ${state.pages} pages${state.truncated ? " · truncated" : ""}`
  return state.error ?? "PDF text is unavailable"
}
