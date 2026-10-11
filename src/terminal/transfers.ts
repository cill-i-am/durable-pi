import { Schema } from "effect"
import { FileId, FileName, MAX_FILE_BYTES } from "../workspace/files"

export const MAX_TRANSFER_BYTES = MAX_FILE_BYTES
export const WorkspacePath = Schema.String.check(
  Schema.isMaxLength(1024),
  Schema.makeFilter((path) => {
    if (!path.startsWith("/workspace/")) return false
    return path
      .slice(11)
      .split("/")
      .every(
        (part) =>
          part.length > 0 &&
          part !== "." &&
          part !== ".." &&
          [...part].every(
            (c) =>
              c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127 && c !== "\\"
          )
      )
  })
)
export const ImportFile = Schema.Struct({
  id: FileId,
  fileId: FileId,
  name: FileName,
})
export const ExportFile = Schema.Struct({ id: FileId, path: WorkspacePath })
export const TransferPlan = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("import"),
    path: WorkspacePath,
    fileId: FileId,
    name: FileName,
    sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  }),
  Schema.Struct({
    kind: Schema.Literal("export"),
    path: WorkspacePath,
    name: FileName,
  }),
])
export type TransferPlan = typeof TransferPlan.Type
export async function fileDigest(bytes: Uint8Array) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer))
  )
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
}
export async function importPlan(
  input: typeof ImportFile.Type,
  bytes: Uint8Array
): Promise<TransferPlan> {
  Schema.decodeUnknownSync(ImportFile)(input)
  if (!bytes.length || bytes.length > MAX_TRANSFER_BYTES)
    throw new Error("Choose a non-empty file up to 8 MB.")
  return {
    kind: "import",
    fileId: input.fileId,
    name: input.name,
    path: `/workspace/imports/${input.id}/${input.name}`,
    sha256: await fileDigest(bytes),
  }
}
export function exportPlan(input: typeof ExportFile.Type): TransferPlan {
  Schema.decodeUnknownSync(ExportFile)(input)
  const name = Schema.decodeUnknownSync(FileName)(input.path.split("/").at(-1))
  return { kind: "export", path: input.path, name }
}
