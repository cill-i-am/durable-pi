"use client"

import { useUIReducedMotion } from "@workspace/ui/hooks/use-ui-reduced-motion"
import { cn } from "@workspace/ui/lib/utils"
import type * as React from "react"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  const reduced = useUIReducedMotion()
  return (
    <div
      data-slot="skeleton"
      data-motion-reduced={reduced ? "true" : undefined}
      aria-hidden="true"
      className={cn(
        "animate-pulse rounded-sm bg-muted data-[motion-reduced=true]:animate-none motion-reduce:animate-none",
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
