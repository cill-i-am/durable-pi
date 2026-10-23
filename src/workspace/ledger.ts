import type { Effect } from "effect"

import type { StoredAudio } from "./audio"
import type {
  WorkspaceUnavailable,
  FileInfo,
  DocumentExtraction,
  FileReply,
} from "./files"
import type { VideoPreparation } from "./video"

export type WorkspaceFile = Omit<FileInfo, "extraction" | "video" | "audio"> & {
  audio?: StoredAudio
  hash: string
  visionHash: string | null
  lifecycleVersion?: number
  attemptId?: string | null
}
export type PreparationIdentity = {
  lifecycleVersion?: number
  attemptId?: string | null
  artifactHash?: string | null
  recoveryDeadline?: number
}
export type DocumentJob = DocumentExtraction &
  PreparationIdentity & { id: string; attempts: number }
export type VideoJob = VideoPreparation &
  PreparationIdentity & {
    id: string
    attempts: number
    retryAt: number
  }
export interface WorkspaceLedger {
  fileReply: (
    operationId: string
  ) => Effect.Effect<FileReply | undefined, WorkspaceUnavailable>
  replyFiles: (
    turnId: string
  ) => Effect.Effect<readonly FileReply[], WorkspaceUnavailable>
  replyFilesForTurns: (
    turnIds: readonly string[]
  ) => Effect.Effect<readonly FileReply[], WorkspaceUnavailable>
  replyFile: (input: FileReply) => Effect.Effect<void, WorkspaceUnavailable>
  readonly transactionGroup: object
  atomic: <TValue, TError, TRequirements>(
    change: () => Effect.Effect<TValue, TError, TRequirements>
  ) => Effect.Effect<TValue, TError | WorkspaceUnavailable, TRequirements>
  read: (
    id: string
  ) => Effect.Effect<WorkspaceFile | undefined, WorkspaceUnavailable>
  list: () => Effect.Effect<WorkspaceFile[], WorkspaceUnavailable>
  usage: () => Effect.Effect<
    { bytes: number; count: number },
    WorkspaceUnavailable
  >
  insert: (file: WorkspaceFile) => Effect.Effect<void, WorkspaceUnavailable>
  promotePdf: (id: string) => Effect.Effect<void, WorkspaceUnavailable>
  saveUpload: (file: WorkspaceFile) => Effect.Effect<void, WorkspaceUnavailable>
  restorePreparation: () => Effect.Effect<void, WorkspaceUnavailable>
  rename: (
    id: string,
    name: string
  ) => Effect.Effect<void, WorkspaceUnavailable>
  trash: (
    id: string,
    trashed: boolean
  ) => Effect.Effect<void, WorkspaceUnavailable>
  document: (
    id: string
  ) => Effect.Effect<DocumentJob | undefined, WorkspaceUnavailable>
  video: (
    id: string
  ) => Effect.Effect<VideoJob | undefined, WorkspaceUnavailable>
  pendingDocument: () => Effect.Effect<
    DocumentJob | undefined,
    WorkspaceUnavailable
  >
  pendingVideo: () => Effect.Effect<VideoJob | undefined, WorkspaceUnavailable>
  pendingRecoveryDeadline: () => Effect.Effect<
    number | undefined,
    WorkspaceUnavailable
  >
  enqueueDocument: (
    id: string,
    recoveryDeadline: number
  ) => Effect.Effect<void, WorkspaceUnavailable>
  enqueueVideo: (
    id: string,
    recoveryDeadline: number
  ) => Effect.Effect<void, WorkspaceUnavailable>
  saveDocument: (
    job: DocumentJob,
    expected?: { attempts: number; attemptId?: string | null }
  ) => Effect.Effect<void, WorkspaceUnavailable>
  saveVideo: (
    job: VideoJob,
    expected?: { attempts: number; attemptId?: string | null }
  ) => Effect.Effect<void, WorkspaceUnavailable>
}
