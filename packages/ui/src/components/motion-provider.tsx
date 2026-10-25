"use client"

import { useUIReducedMotion } from "@workspace/ui/hooks/use-ui-reduced-motion"
import { MotionConfig } from "motion/react"
import type { ReactNode } from "react"

function MotionProvider({
  children,
  reducedMotion = "user",
}: {
  children: ReactNode
  reducedMotion?: "user" | "always"
}) {
  const reduce = useUIReducedMotion()
  return (
    <MotionConfig
      reducedMotion={reduce || reducedMotion === "always" ? "always" : "user"}
    >
      {children}
    </MotionConfig>
  )
}

export { MotionProvider }
