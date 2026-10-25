const key = "pi:family-invitation:v1"
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">
function read(storage: Store) {
  try {
    const raw = storage.getItem(key)
    if (raw === null) return { kind: "empty" as const }
    const value: unknown = JSON.parse(raw)
    return value &&
      typeof value === "object" &&
      "version" in value &&
      "invitation" in value &&
      value.version === 1 &&
      typeof value.invitation === "string" &&
      value.invitation.length > 0 &&
      value.invitation.length <= 200
      ? { kind: "valid" as const, id: value.invitation as string }
      : { kind: "unreadable" as const }
  } catch {
    return { kind: "unreadable" as const }
  }
}
/** A tab-local invitation identity survives the auth SDK's challenge redirect.
 * Secrets never enter this record. Unknown/corrupt records are retained. */
export function invitationRecord(storage: Store) {
  return {
    restore: () => {
      const record = read(storage)
      return record.kind === "valid" ? record.id : null
    },
    remember: (id: string) => {
      if (!id || id.length > 200 || read(storage).kind === "unreadable") return
      try {
        storage.setItem(key, JSON.stringify({ version: 1, invitation: id }))
      } catch {
        /* The URL remains the active invitation identity. */
      }
    },
    joined: (id: string) => {
      const record = read(storage)
      if (record.kind === "valid" && record.id === id) {
        try {
          storage.removeItem(key)
        } catch {
          /* A confirmed join does not depend on tab storage. */
        }
      }
    },
  }
}
