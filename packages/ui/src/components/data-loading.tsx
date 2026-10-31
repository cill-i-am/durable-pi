"use client"

import { useUIReducedMotion } from "@workspace/ui/hooks/use-ui-reduced-motion"
import { cn } from "@workspace/ui/lib/utils"
import type { ReactNode } from "react"
import { Skeleton, SkulletProvider } from "skullet/react"

// Keep loading policy here so the rollout can be tuned or reverted in one place.
// No persistent shape IDs: private account layouts should not outlive a session.
export function DataLoadingProvider({ children }: { children: ReactNode }) {
  const reduced = useUIReducedMotion()
  return (
    <SkulletProvider
      reveal={{
        order: "together",
        duration: reduced ? 0 : 180,
        hold: reduced ? 0 : 150,
      }}
      theme={{
        animation: reduced ? "none" : "shimmer",
        speed: "slow",
        radius: "6px",
      }}
    >
      {children}
    </SkulletProvider>
  )
}

type Layout =
  | "list"
  | "detail"
  | "form"
  | "conversation"
  | "media"
  | "code"
  | "line"

/** A measured, inert sample on first load; real content reveals in the same boundary. */
export function DataLoading({
  loading,
  label,
  layout = "list",
  children,
  sample,
  className,
}: {
  loading: boolean
  label: string
  layout?: Layout
  children?: ReactNode
  /** Use a presentation-only sample, never a component that fetches or mutates. */
  sample?: ReactNode
  className?: string
}) {
  return (
    <Skeleton
      loading={loading}
      label={label}
      className={cn("data-loading", className)}
    >
      {loading ? (sample ?? <LoadingSample layout={layout} />) : children}
    </Skeleton>
  )
}

function LoadingSample({ layout }: { layout: Layout }) {
  if (layout === "line")
    return <p className="text-sm">Loading your workspace</p>
  if (layout === "media")
    return (
      <div className="skullet-block aspect-video min-h-32 w-full rounded-md bg-muted" />
    )
  if (layout === "code")
    return (
      <pre className="overflow-hidden p-4 text-sm leading-6">
        {
          "Reading the saved output\n  Preparing the next line\n  Restoring the latest result\nReady to display the response"
        }
      </pre>
    )
  if (layout === "form")
    return (
      <div className="flex flex-col gap-5 py-2">
        {["Configuration", "Preferences", "Available options"].map((title) => (
          <div key={title} className="flex flex-col gap-2">
            <p className="text-sm font-medium">{title}</p>
            <div className="skullet-block h-9 w-full rounded-md bg-muted" />
          </div>
        ))}
      </div>
    )
  if (layout === "conversation")
    return (
      <div className="flex flex-col gap-8 py-6">
        <p className="self-end text-sm">A message in your conversation</p>
        <div className="flex max-w-prose flex-col gap-2 text-sm">
          <p>Restoring the latest messages in this conversation.</p>
          <p>The response and its supporting details will appear here.</p>
          <p>Continuing where you left off.</p>
        </div>
      </div>
    )
  if (layout === "detail")
    return (
      <div className="flex flex-col gap-4 py-2">
        <h3 className="text-lg font-medium">Saved details</h3>
        <p className="text-sm">The latest information for this item.</p>
        <LoadingSample layout="list" />
      </div>
    )
  return (
    <div className="flex flex-col divide-y">
      {["Latest saved item", "Another recent update", "Previous activity"].map(
        (title) => (
          <div key={title} className="flex min-w-0 items-center gap-3 py-4">
            <div className="skullet-block size-8 shrink-0 rounded-md bg-muted" />
            <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
              <p>{title}</p>
              <p className="text-xs text-muted-foreground">
                Details and current status
              </p>
            </div>
          </div>
        )
      )}
    </div>
  )
}
