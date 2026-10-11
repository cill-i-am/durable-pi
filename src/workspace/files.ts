import { Schema } from "effect"

export const MAX_FILE_BYTES = 8 * 1024 * 1024
export const MAX_VISION_BYTES = 192 * 1024
export const MAX_ATTACHMENTS = 4
export const FileId = Schema.String.check(
  Schema.isPattern(
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
  )
)
export type FileId = typeof FileId.Type
export const FileName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(180),
  Schema.isPattern(/^[^/\\]+$/),
  Schema.makeFilter((name) =>
    [...name].every(
      (character) =>
        character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
    )
  ),
  Schema.makeFilter(
    (name) => name === name.trim() && name !== "." && name !== ".."
  )
)
export const DocumentExtraction = Schema.Struct({
  status: Schema.Literals(["pending", "running", "ready", "empty", "failed"]),
  pages: Schema.Number,
  readPages: Schema.Number,
  characters: Schema.Number,
  truncated: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
})
export type DocumentExtraction = typeof DocumentExtraction.Type
export const FileInfo = Schema.Struct({
  id: FileId,
  name: FileName,
  mime: Schema.String,
  kind: Schema.Literals(["image", "text", "video", "document"]),
  size: Schema.Number,
  createdAt: Schema.String,
  status: Schema.Literals(["uploading", "ready"]),
  trashed: Schema.Boolean,
  extraction: Schema.optional(DocumentExtraction),
})
export type FileInfo = typeof FileInfo.Type
export const AttachmentContent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("image"),
    mimeType: Schema.String,
    data: Schema.String,
  }),
])
export type AttachmentContent = typeof AttachmentContent.Type
export const messageArchiveText = (
  text: string,
  files: readonly FileInfo[] = []
) =>
  text +
  (files.length
    ? `\nAttachments:\n${files.map((file) => `- ${JSON.stringify(file.name)} (asset ${file.id})`).join("\n")}`
    : "")
export const FileList = Schema.Struct({ files: Schema.Array(FileInfo) })
export const FileSelection = Schema.Array(FileId).check(
  Schema.isMaxLength(MAX_ATTACHMENTS),
  Schema.makeFilter((ids) => new Set(ids).size === ids.length)
)
export class FileRejected extends Schema.TaggedError<FileRejected>()(
  "FileRejected",
  { message: Schema.String }
) {}
export class FileNotFound extends Schema.TaggedError<FileNotFound>()(
  "FileNotFound",
  {}
) {}
export class WorkspaceReadOnly extends Schema.TaggedError<WorkspaceReadOnly>()(
  "WorkspaceReadOnly",
  {}
) {}
export class WorkspaceUnavailable extends Schema.TaggedError<WorkspaceUnavailable>()(
  "WorkspaceUnavailable",
  {}
) {}
export type FileError =
  FileRejected | FileNotFound | WorkspaceUnavailable | WorkspaceReadOnly
export type Upload = {
  id: FileId
  name: string
  mime: string
  bytes: Uint8Array
  vision?: Uint8Array
}

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  new TextDecoder().decode(bytes.slice(start, end))
export function imageMime(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg"
  if (
    bytes.length >= 24 &&
    bytes
      .slice(0, 8)
      .every((byte, i) => byte === [137, 80, 78, 71, 13, 10, 26, 10][i])
  )
    return "image/png"
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP")
    return "image/webp"
  return undefined
}
export function inspectFile(
  upload: Upload
): Pick<FileInfo, "name" | "mime" | "kind" | "size"> {
  const name = Schema.decodeUnknownOption(FileName)(upload.name)
  if (name._tag === "None")
    throw new FileRejected({
      message:
        "Use a file name without folders or control characters (up to 180 characters).",
    })
  if (!upload.bytes.length || upload.bytes.length > MAX_FILE_BYTES)
    throw new FileRejected({ message: "Choose a non-empty file up to 8 MB." })
  if (ascii(upload.bytes, 0, 5) === "%PDF-")
    return {
      name: name.value,
      kind: "document",
      mime: "application/pdf",
      size: upload.bytes.length,
    }
  const image = imageMime(upload.bytes)
  if (image)
    return {
      name: name.value,
      kind: "image",
      mime: image,
      size: upload.bytes.length,
    }
  if (upload.mime.startsWith("image/"))
    throw new FileRejected({ message: "Use a PNG, JPEG or WebP image." })
  if (upload.mime === "video/mp4" && ascii(upload.bytes, 4, 8) === "ftyp")
    return {
      name: name.value,
      kind: "video",
      mime: "video/mp4",
      size: upload.bytes.length,
    }
  if (
    upload.mime === "video/webm" &&
    upload.bytes.length >= 4 &&
    upload.bytes
      .slice(0, 4)
      .every((byte, i) => byte === [0x1a, 0x45, 0xdf, 0xa3][i])
  )
    return {
      name: name.value,
      kind: "video",
      mime: "video/webm",
      size: upload.bytes.length,
    }
  if (
    /\.(txt|md|markdown|json|jsonl|csv|tsv|yaml|yml|log|js|jsx|ts|tsx|css|html|xml|py|sh)$/i.test(
      name.value
    )
  ) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(upload.bytes)
    } catch {
      throw new FileRejected({ message: "Text files must use UTF-8 encoding." })
    }
    if (upload.bytes.includes(0))
      throw new FileRejected({ message: "This file contains binary data." })
    return {
      name: name.value,
      kind: "text",
      mime: "text/plain; charset=utf-8",
      size: upload.bytes.length,
    }
  }
  return {
    name: name.value,
    kind: "document",
    mime: "application/octet-stream",
    size: upload.bytes.length,
  }
}
