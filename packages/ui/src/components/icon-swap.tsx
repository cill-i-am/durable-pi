"use client"

import { useUIReducedMotion } from "@workspace/ui/hooks/use-ui-reduced-motion"
import { motionSpring } from "@workspace/ui/lib/motion"
import { cn } from "@workspace/ui/lib/utils"
import { motion } from "motion/react"
import type * as React from "react"

type IconSwapProps = Omit<
  React.ComponentProps<"span">,
  "children" | "aria-hidden" | "aria-label" | "aria-labelledby" | "role"
> & {
  active: boolean
  activeIcon: React.ReactNode
  inactiveIcon: React.ReactNode
}

/**
 * Decorative icon pair: CSS owns the 100ms opacity fade; Motion owns 300ms geometry.
 * Keep the control's accessible name and state outside.
 */
function IconSwap({
  active,
  activeIcon,
  inactiveIcon,
  className,
  ...props
}: IconSwapProps) {
  const reduced = useUIReducedMotion()
  const transition = reduced ? { duration: 0 } : motionSpring
  const layer = (shown: boolean) => ({
    scale: reduced || shown ? 1 : 0.25,
    filter: reduced ? "none" : shown ? "blur(0px)" : "blur(4px)",
  })
  return (
    <span
      {...props}
      data-slot="icon-swap"
      data-active={active ? "true" : "false"}
      data-motion-reduced={reduced ? "true" : undefined}
      aria-hidden="true"
      className={cn(
        "pointer-events-none inline-grid size-[18px] shrink-0 place-items-center align-middle",
        // A new duration does not stop an existing spring toward the same target.
        // Gate its painted properties as soon as either reduced preference applies.
        "data-[motion-reduced=true]:[&>span]:transform-none! data-[motion-reduced=true]:[&>span]:filter-none! motion-reduce:[&>span]:transform-none! motion-reduce:[&>span]:filter-none!",
        className
      )}
    >
      <motion.span
        data-slot="icon-swap-inactive"
        aria-hidden="true"
        initial={false}
        animate={layer(!active)}
        transition={transition}
        className={cn(
          "col-start-1 row-start-1 grid size-full place-items-center transition-opacity duration-(--ui-motion-fast) ease-(--ui-motion-ease) [&>svg]:size-full",
          active ? "opacity-0" : "opacity-100"
        )}
      >
        {inactiveIcon}
      </motion.span>
      <motion.span
        data-slot="icon-swap-active"
        aria-hidden="true"
        initial={false}
        animate={layer(active)}
        transition={transition}
        className={cn(
          "col-start-1 row-start-1 grid size-full place-items-center transition-opacity duration-(--ui-motion-fast) ease-(--ui-motion-ease) [&>svg]:size-full",
          active ? "opacity-100" : "opacity-0"
        )}
      >
        {activeIcon}
      </motion.span>
    </span>
  )
}

export { IconSwap, type IconSwapProps }
