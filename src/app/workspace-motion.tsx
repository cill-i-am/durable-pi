import { MotionProvider } from "@workspace/ui/components/motion-provider"
import { useEffect, type ReactNode } from "react"

import { useActivityMotion } from "@/hooks/activity-motion"

/** Project the existing device preference into both Motion and CSS, including
 * native overlays whose portals live outside the application DOM subtree. */
export function WorkspaceMotion({ children }: { children: ReactNode }) {
  const { animate } = useActivityMotion()
  useEffect(() => {
    document.documentElement.dataset.uiMotion = animate ? "full" : "reduced"
    return () => {
      delete document.documentElement.dataset.uiMotion
    }
  }, [animate])
  return (
    <MotionProvider reducedMotion={animate ? "user" : "always"}>
      {children}
    </MotionProvider>
  )
}
