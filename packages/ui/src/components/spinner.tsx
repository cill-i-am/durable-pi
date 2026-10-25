"use client"

import { useUIReducedMotion } from "@workspace/ui/hooks/use-ui-reduced-motion"
import { cn } from "cn"
import type { ComponentProps } from "react"

function Spinner({ className, ...props }: ComponentProps<"svg">) {
  const reduced = useUIReducedMotion()
  return (
    <svg
      data-slot="spinner"
      aria-hidden="true"
      data-motion-reduced={reduced ? "true" : undefined}
      viewBox="0 0 24 24"
      fill="none"
      className={cn(
        "size-4 shrink-0 text-current motion-reduce:animate-none",
        !reduced && "animate-spin",
        className
      )}
      {...props}
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="2"
        opacity="0.25"
      />
      <path
        d="M12 3a9 9 0 0 1 9 9"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}

export { Spinner }
