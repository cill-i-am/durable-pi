"use client"

import { MotionConfigContext } from "motion/react"
import { useContext, useSyncExternalStore } from "react"

let media: MediaQueryList | undefined
function preference() {
  return (media ??= window.matchMedia("(prefers-reduced-motion: reduce)"))
}
function subscribe(notify: () => void) {
  const query = preference()
  query.addEventListener("change", notify)
  return () => query.removeEventListener("change", notify)
}
const snapshot = () => preference().matches
const serverSnapshot = () => true

// Motion 14.3's hook snapshots the preference once. Subscribe to the native
// value so a preference change also stops an already-mounted animation.
function useUIReducedMotion() {
  const config = useContext(MotionConfigContext)
  const system = useSyncExternalStore(subscribe, snapshot, serverSnapshot)
  return config.reducedMotion === "always" || system
}

export { useUIReducedMotion }
