import { lazy, Suspense, type ReactNode, type ComponentProps } from "react"
import type { ThinkingOrb as NativeThinkingOrb } from "thinking-orbs"

import { useActivityMotion } from "@/hooks/activity-motion"

// Optional animation downloads must not unmount the live chat or its draft.
const ThinkingOrb = lazy(() =>
  import("thinking-orbs")
    .then((module) => ({ default: module.ThinkingOrb }))
    .catch(() => ({ default: StaticOrb }))
)
const ActivityBorderEffect = lazy<() => ReactNode>(() =>
  import("./activity-border-effect")
    .then((module) => ({ default: module.ActivityBorderEffect }))
    .catch(() => ({ default: () => null }))
)

function StaticOrb() {
  return <span aria-hidden="true" className="activity-orb size-5 shrink-0" />
}

export function ActivityOrb({
  state = "working",
  active = true,
}: {
  state?: ComponentProps<typeof NativeThinkingOrb>["state"]
  active?: boolean
}) {
  const { animate } = useActivityMotion()
  return (
    <Suspense fallback={<StaticOrb />}>
      <ThinkingOrb
        state={state}
        size={20}
        theme="auto"
        speed={0.7}
        paused={!active || !animate}
        aria-hidden="true"
        className="activity-orb shrink-0"
      />
    </Suspense>
  )
}

export function ActivityBorder({
  active,
  children,
}: {
  active: boolean
  children: ReactNode
}) {
  const { animate } = useActivityMotion()
  return (
    <div className="activity-border">
      {children}
      {active && animate && (
        <Suspense fallback={null}>
          <ActivityBorderEffect />
        </Suspense>
      )}
    </div>
  )
}
