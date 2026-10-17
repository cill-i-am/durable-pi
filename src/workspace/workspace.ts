import { Context, type Effect, type Scope, type Stream } from "effect"

import type {
  AttachmentContent,
  FileError,
  FileId,
  FileInfo,
  Upload,
  WorkspaceUnavailable,
  ImageReply,
} from "./files"
import type { VideoResult } from "./video"

export type FileContent = {
  info: FileInfo
  body: Stream.Stream<Uint8Array, WorkspaceUnavailable>
  size: number
  mime: string
}
export type { AttachmentContent } from "./files"
export class Workspace extends Context.Service<
  Workspace,
  {
    replyImage: (input: ImageReply) => Effect.Effect<FileInfo, FileError>
    imageReplies: (turnId: string) => Effect.Effect<FileInfo[], FileError>
    video: (id: FileId) => Effect.Effect<VideoResult, FileError>
    list: () => Effect.Effect<FileInfo[], FileError>
    extractionPending: () => Effect.Effect<boolean, FileError>
    extractNext: () => Effect.Effect<boolean, FileError>
    retryExtraction: (id: FileId) => Effect.Effect<FileInfo, FileError>
    readText: (
      id: FileId,
      offset: number,
      limit: number
    ) => Effect.Effect<
      {
        file: FileInfo
        text: string
        offset: number
        next: number | null
        total: number
      },
      FileError
    >
    upload: (input: Upload) => Effect.Effect<FileInfo, FileError>
    content: (
      id: FileId,
      vision?: boolean
    ) => Effect.Effect<FileContent, FileError, Scope.Scope>
    trash: (id: FileId, trashed: boolean) => Effect.Effect<FileInfo, FileError>
    rename: (id: FileId, name: string) => Effect.Effect<FileInfo, FileError>
    requireFiles: (
      ids: readonly FileId[]
    ) => Effect.Effect<FileInfo[], FileError>
    attach: (
      ids: readonly FileId[]
    ) => Effect.Effect<
      { files: FileInfo[]; content: AttachmentContent[] },
      FileError
    >
  }
>()("durable-pi/workspace/Workspace") {}
