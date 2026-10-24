import { Schema } from "effect"

import { SendInput } from "@/conversations/contracts"
import { Profile, JobType } from "@/inference/policy"
import { FileInfo } from "@/workspace/files"

const DraftFile = Schema.Struct({
  id: FileInfo.fields.id,
  name: FileInfo.fields.name,
  mime: FileInfo.fields.mime,
  kind: FileInfo.fields.kind,
  size: FileInfo.fields.size,
  createdAt: FileInfo.fields.createdAt,
  status: FileInfo.fields.status,
  trashed: FileInfo.fields.trashed,
})
export const ComposerDraft = Schema.Struct({
  version: Schema.Literal(1),
  text: Schema.String.check(Schema.isMaxLength(30_000)),
  files: Schema.Array(DraftFile).check(Schema.isMaxLength(4)),
  profile: Profile,
  job: JobType,
  attempt: Schema.NullOr(SendInput),
})
export type ComposerDraft = typeof ComposerDraft.Type
export const emptyDraft = (): ComposerDraft => ({
  version: 1,
  text: "",
  files: [],
  profile: "auto",
  job: "conversation",
  attempt: null,
})
