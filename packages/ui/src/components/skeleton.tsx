"use client"

import { useUIReducedMotion } from "@workspace/ui/hooks/use-ui-reduced-motion"
import { cn } from "@workspace/ui/lib/utils"
import type * as React from "react"
import { SkeletonBox } from "skullet/react"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  const reduced = useUIReducedMotion()
  return (
    <div
      data-slot="skeleton"
      data-motion-reduced={reduced ? "true" : undefined}
      aria-hidden="true"
      className={cn("rounded-sm", className)}
      {...props}
    >
      <SkeletonBox
        width="100%"
        height="100%"
        radius="inherit"
        style={
          {
            "--skullet-animation": reduced ? "none" : "shimmer",
          } as React.CSSProperties
        }
      />
    </div>
  )
}

export { Skeleton }
