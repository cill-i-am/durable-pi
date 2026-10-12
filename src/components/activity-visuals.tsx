import type { ReactNode, ComponentProps } from "react"
import { ThinkingOrb } from "thinking-orbs"
import { BorderBeam } from "border-beam"
import { useAppTheme } from "@/hooks/use-app-theme"
import { useActivityMotion } from "@/hooks/activity-motion"

/** Decorative only: callers keep the activity label and execution state. */
export function ActivityOrb({
  state = "working",
  active = true,
}: {
  state?: ComponentProps<typeof ThinkingOrb>["state"]
  active?: boolean
}) {
  const { animate } = useActivityMotion()
  return (
    <ThinkingOrb
      state={state}
      size={20}
      theme="auto"
      speed={0.7}
      paused={!active || !animate}
      aria-hidden="true"
      className="activity-orb shrink-0"
    />
  )
}

/** Keep mounted when idle so changing run state never remounts a draft. */
export function ActivityBorder({
  active,
  children,
}: {
  active: boolean
  children: ReactNode
}) {
  const { resolvedTheme } = useAppTheme()
  const { animate } = useActivityMotion()
  return (
    <BorderBeam
      className="activity-border"
      size="line"
      colorVariant="ocean"
      theme={resolvedTheme === "dark" ? "dark" : "light"}
      active={active && animate}
      duration={7}
      strength={0.3}
      glowSize={0.6}
      staticColors
    >
      {children}
    </BorderBeam>
  )
}
