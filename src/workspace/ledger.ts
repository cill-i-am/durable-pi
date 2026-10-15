import type { FileInfo, DocumentExtraction } from "./files"
import type { VideoPreparation } from "./video"

export type WorkspaceFile = Omit<FileInfo, "extraction" | "video"> & {
  hash: string
  visionHash: string | null
}
export type DocumentJob = DocumentExtraction & { id: string; attempts: number }
export type VideoJob = VideoPreparation & {
  id: string
  attempts: number
  retryAt: number
}
export interface WorkspaceLedger {
  readonly transactionGroup: object
  atomic: <T>(change: () => T) => T
  read: (id: string) => WorkspaceFile | undefined
  list: () => WorkspaceFile[]
  usage: () => { bytes: number; count: number }
  insert: (file: WorkspaceFile) => void
  promotePdf: (id: string) => void
  ready: (id: string) => void
  rename: (id: string, name: string) => void
  trash: (id: string, trashed: boolean) => void
  document: (id: string) => DocumentJob | undefined
  video: (id: string) => VideoJob | undefined
  pendingDocument: () => DocumentJob | undefined
  pendingVideo: () => VideoJob | undefined
  enqueueDocument: (id: string) => void
  enqueueVideo: (id: string) => void
  claimDocument: (job: DocumentJob) => boolean
  claimVideo: (job: VideoJob) => boolean
  saveDocument: (job: DocumentJob, expectedAttempts?: number) => void
  saveVideo: (job: VideoJob, expectedAttempts?: number) => void
}
