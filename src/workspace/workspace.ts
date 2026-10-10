import { Context, type Effect } from "effect"
import type {
  AttachmentContent,
  FileError,
  FileId,
  FileInfo,
  Upload,
} from "./files"

export type FileContent = {
  info: FileInfo
  body: ReadableStream<Uint8Array>
  size: number
  mime: string
}
export type { AttachmentContent } from "./files"
export class Workspace extends Context.Service<
  Workspace,
  {
    list: () => Effect.Effect<FileInfo[], FileError>
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
    ) => Effect.Effect<FileContent, FileError>
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
