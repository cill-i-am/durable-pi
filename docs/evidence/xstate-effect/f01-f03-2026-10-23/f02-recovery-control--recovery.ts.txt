/** Browser recovery owns update/connection state and a reload fence, never work
 * submission. All navigation remains an explicit user action. */
export function createRecovery(currentRevision: string, reload: () => void) {
  let state = {
    revision: null as string | null,
    blocked: null as string | null,
    online: true,
    reloading: false,
  }
  const listeners = new Set<() => void>()
  const blockers = new Map<string, string>()
  function update(change: Partial<typeof state>) {
    const next = { ...state, ...change }
    if (JSON.stringify(next) === JSON.stringify(state)) return
    state = next
    listeners.forEach((listener) => listener())
  }
  return {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    observe: (revision: unknown) => {
      if (
        typeof revision === "string" &&
        /^[a-f0-9]{40}$/.test(revision) &&
        revision !== currentRevision
      )
        update({ revision })
    },
    connection: (online: boolean) => update({ online }),
    block: (key: string, reason: string | null) => {
      if (reason) blockers.set(key, reason)
      else blockers.delete(key)
      update({ blocked: blockers.values().next().value ?? null })
    },
    reload: () => {
      if (state.blocked || !state.online || state.reloading) return false
      update({ reloading: true })
      try {
        reload()
      } catch {
        update({ reloading: false })
        return false
      }
      return true
    },
  }
}
export function importFailure(error: unknown): error is Error {
  if (!(error instanceof Error)) return false
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Loading (?:CSS )?chunk [\w-]+ failed/i.test(
    error.message
  )
}
