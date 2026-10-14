import { useSyncExternalStore } from "react"

const storageKey = "durable-pi:interaction-sound"
const changeEvent = "durable-pi:interaction-sound-change"
let sessionEnabled = true
let storageWriteFailed = false

export const isInteractionSoundEnabled = () => {
  if (storageWriteFailed) return sessionEnabled
  try {
    const saved = window.localStorage.getItem(storageKey)
    return saved === null ? sessionEnabled : saved !== "off"
  } catch {
    return sessionEnabled
  }
}

const subscribe = (onChange: () => void) => {
  window.addEventListener("storage", onChange)
  window.addEventListener(changeEvent, onChange)
  return () => {
    window.removeEventListener("storage", onChange)
    window.removeEventListener(changeEvent, onChange)
  }
}

const setEnabled = (enabled: boolean) => {
  sessionEnabled = enabled
  try {
    window.localStorage.setItem(storageKey, enabled ? "on" : "off")
    storageWriteFailed = false
  } catch {
    storageWriteFailed = true
  }
  window.dispatchEvent(new Event(changeEvent))
}

export const useInteractionSoundPreference = () => {
  const enabled = useSyncExternalStore(
    subscribe,
    isInteractionSoundEnabled,
    () => true
  )
  return { enabled, setEnabled }
}
