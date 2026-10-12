import { useSyncExternalStore } from "react"

const storageKey = "durable-pi:activity-motion"
const changeEvent = "durable-pi:activity-motion-change"
const reducedMotionQuery = "(prefers-reduced-motion: reduce)"
let sessionEnabled = true
let storageWriteFailed = false

function enabledSnapshot() {
  if (storageWriteFailed) return sessionEnabled
  try {
    const saved = window.localStorage.getItem(storageKey)
    return saved === null ? sessionEnabled : saved !== "off"
  } catch {
    return sessionEnabled
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange)
  window.addEventListener(changeEvent, onChange)
  return () => {
    window.removeEventListener("storage", onChange)
    window.removeEventListener(changeEvent, onChange)
  }
}

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia(reducedMotionQuery)
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

function setEnabled(enabled: boolean) {
  sessionEnabled = enabled
  try {
    window.localStorage.setItem(storageKey, enabled ? "on" : "off")
    storageWriteFailed = false
  } catch {
    // Keep the control useful for this session when device storage is blocked.
    storageWriteFailed = true
  }
  window.dispatchEvent(new Event(changeEvent))
}

export function useActivityMotion() {
  const enabled = useSyncExternalStore(subscribe, enabledSnapshot, () => true)
  const reduced = useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(reducedMotionQuery).matches,
    () => true
  )
  return { enabled, setEnabled, reduced, animate: enabled && !reduced }
}
