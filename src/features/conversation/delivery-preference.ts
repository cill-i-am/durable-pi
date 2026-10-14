import { useSyncExternalStore } from "react"
import type { SubmissionMode } from "@/conversations/turns"

const storageKey = "durable-pi:message-delivery"
const changeEvent = "durable-pi:message-delivery-change"
let sessionMode: SubmissionMode = "steer"
let storageWriteFailed = false

export function messageDeliveryDefault(): SubmissionMode {
  if (storageWriteFailed) return sessionMode
  try {
    const saved = window.localStorage.getItem(storageKey)
    return saved === "followUp" ? "followUp" : "steer"
  } catch {
    return sessionMode
  }
}

export function setMessageDeliveryDefault(mode: SubmissionMode) {
  sessionMode = mode
  try {
    window.localStorage.setItem(storageKey, mode)
    storageWriteFailed = false
  } catch {
    storageWriteFailed = true
  }
  window.dispatchEvent(new Event(changeEvent))
}

const subscribe = (onChange: () => void) => {
  window.addEventListener("storage", onChange)
  window.addEventListener(changeEvent, onChange)
  return () => {
    window.removeEventListener("storage", onChange)
    window.removeEventListener(changeEvent, onChange)
  }
}

export function useMessageDeliveryDefault(): SubmissionMode {
  return useSyncExternalStore<SubmissionMode>(
    subscribe,
    messageDeliveryDefault,
    () => "steer"
  )
}
