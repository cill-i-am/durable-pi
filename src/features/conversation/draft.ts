import { Schema } from "effect"

import { ComposerDraft, emptyDraft } from "./composer-draft"
export { emptyDraft, type ComposerDraft } from "./composer-draft"

export class UnreadableComposerDraft extends Schema.TaggedError<UnreadableComposerDraft>()(
  "UnreadableComposerDraft",
  { message: Schema.String }
) {}
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
  if (value === null) return emptyDraft()
  if (value.length > 500_000)
    throw new UnreadableComposerDraft({
      message: "The saved draft is too large to read safely.",
    })
  try {
    return Schema.decodeUnknownSync(ComposerDraft)(JSON.parse(value))
  } catch {
    throw new UnreadableComposerDraft({
      message:
        "The saved draft could not be read. Its original data has been retained.",
    })
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
    Schema.decodeUnknownSync(ComposerDraft)({ ...draft, files })
  )
  if (encoded.length > 500_000)
    throw new Error("The tab-local draft is too large to preserve.")
  storage.setItem(key, encoded)
}
