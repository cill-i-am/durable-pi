import type { FileInfo } from "@/workspace/files"

export const preparingFile = (file: FileInfo) =>
  !file.trashed &&
  file.status === "ready" &&
  (file.extraction?.status === "pending" ||
    file.extraction?.status === "running" ||
    file.video?.status === "pending" ||
    file.video?.status === "running")
export const legacyPdf = (file: FileInfo) =>
  file.kind === "document" &&
  file.mime === "application/octet-stream" &&
  /\.pdf$/i.test(file.name)
export const attachmentReady = (file: FileInfo) =>
  !file.trashed &&
  file.status === "ready" &&
  (file.mime !== "application/pdf" || file.extraction?.status === "ready") &&
  (file.kind !== "video" || file.video?.status === "ready")
export function fileDescription(file: FileInfo) {
  if (file.kind === "video") {
    if (!file.video) return "Video · Frames not prepared"
    if (file.video.status === "ready")
      return `Video · ${file.video.frames} frames · ${Math.round(file.video.duration)}s${file.video.captions ? " · captions" : " · no transcript"}`
    if (file.video.status === "failed")
      return file.video.error ?? "Video preparation failed"
    return file.trashed
      ? "Video · Preparation paused until restored"
      : "Video · Preparing frames…"
  }
  const state = file.extraction
  if (!state) return file.kind === "document" ? "Stored only" : file.kind
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
