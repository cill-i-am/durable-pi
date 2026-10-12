import { useSyncExternalStore } from "react"
import { useTheme } from "next-themes"

const subscribe = () => () => {}
const clientSnapshot = () => true
const serverSnapshot = () => false

/** Keep theme-dependent markup identical on the server and first client render.
 * next-themes applies the actual document colors before hydration itself.
 */
export function useAppTheme() {
  const { theme, setTheme, resolvedTheme } = useTheme()
  const ready = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot)
  return {
    theme: ready ? (theme ?? "system") : "system",
    resolvedTheme: ready ? resolvedTheme : undefined,
    setTheme,
    ready,
  }
}
