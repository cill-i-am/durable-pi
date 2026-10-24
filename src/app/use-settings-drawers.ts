import { useRef, useState } from "react"

import type { SettingsFrame } from "@/navigation/settings-stack"

function prefixLength(
  left: readonly SettingsFrame[],
  right: readonly SettingsFrame[]
) {
  let index = 0
  while (index < left.length && left[index]?.id === right[index]?.id) index++
  return index
}

/** Keep outgoing route bodies alive until their native drawer finishes closing. */
export function useSettingsDrawers(desired: readonly SettingsFrame[]) {
  const [rendered, setRendered] = useState<readonly SettingsFrame[]>(desired)
  const prefix = prefixLength(rendered, desired)
  const next =
    prefix === rendered.length
      ? desired
      : [...desired.slice(0, prefix), ...rendered.slice(prefix)]
  if (
    next.length !== rendered.length ||
    next.some((frame, index) => frame.href !== rendered[index]?.href)
  ) {
    setRendered(next)
  }
  const desiredRef = useRef(desired)
  desiredRef.current = desired
  function closed(id: string) {
    setRendered((current) => {
      const index = current.findIndex((frame) => frame.id === id)
      if (index < 0 || index < prefixLength(current, desiredRef.current))
        return current
      return current.slice(0, index)
    })
  }
  return { frames: next, depth: prefixLength(next, desired), closed }
}
