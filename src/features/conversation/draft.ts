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
const Draft = Schema.Struct({
  version: Schema.Literal(1),
  text: Schema.String.check(Schema.isMaxLength(30_000)),
  files: Schema.Array(DraftFile).check(Schema.isMaxLength(4)),
  profile: Profile,
  job: JobType,
  attempt: Schema.NullOr(SendInput),
})
export type ComposerDraft = typeof Draft.Type
export const emptyDraft = (): ComposerDraft => ({
  version: 1,
  text: "",
  files: [],
  profile: "auto",
  job: "conversation",
  attempt: null,
})
const prefix = "pi:composer:"
const ownerKey = "pi:composer-owner"
export const draftKey = (ownerId: string, agentId: string) =>
  `${prefix}${encodeURIComponent(ownerId)}:${encodeURIComponent(agentId)}`
export function adoptDraftOwner(storage: Storage, ownerId: string | null) {
  const previous = storage.getItem(ownerKey)
  if (previous !== ownerId) {
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index)
      if (key?.startsWith(prefix)) storage.removeItem(key)
    }
    if (ownerId) storage.setItem(ownerKey, ownerId)
    else storage.removeItem(ownerKey)
  }
}
export function readDraft(
  storage: Storage,
  ownerId: string,
  agentId: string
): ComposerDraft {
  adoptDraftOwner(storage, ownerId)
  const value = storage.getItem(draftKey(ownerId, agentId))
  if (!value || value.length > 500_000) return emptyDraft()
  try {
    const decoded = Schema.decodeUnknownOption(Draft)(JSON.parse(value))
    return decoded._tag === "Some" ? decoded.value : emptyDraft()
  } catch {
    return emptyDraft()
  }
}
export function writeDraft(
  storage: Storage,
  ownerId: string,
  agentId: string,
  draft: ComposerDraft
) {
  if (storage.getItem(ownerKey) !== ownerId)
    throw new Error("The draft owner is no longer signed in.")
  const key = draftKey(ownerId, agentId)
  if (!draft.text && !draft.files.length && !draft.attempt) {
    storage.removeItem(key)
    return
  }
  // Persist attachment references only, not bytes, transcripts or prepared media.
  const files = draft.files.map(
    ({ id, name, mime, kind, size, createdAt, status, trashed }) => ({
      id,
      name,
      mime,
      kind,
      size,
      createdAt,
      status,
      trashed,
    })
  )
  const encoded = JSON.stringify(
    Schema.decodeUnknownSync(Draft)({ ...draft, files })
  )
  if (encoded.length > 500_000)
    throw new Error("The tab-local draft is too large to preserve.")
  storage.setItem(key, encoded)
}
