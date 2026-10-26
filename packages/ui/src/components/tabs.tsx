"use client"

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { useUIReducedMotion } from "@workspace/ui/hooks/use-ui-reduced-motion"
import { cn } from "cn"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      orientation={orientation}
      className={(state) =>
        cn(
          "group/tabs flex min-w-0 gap-4 data-[orientation=horizontal]:flex-col",
          typeof className === "function" ? className(state) : className
        )
      }
      {...props}
    />
  )
}

function TabsList({ className, children, ...props }: TabsPrimitive.List.Props) {
  const reduced = useUIReducedMotion()
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-motion-reduced={reduced ? "true" : undefined}
      className={(state) =>
        cn(
          "group/tabs-list rounded-control relative isolate inline-flex w-fit max-w-full min-w-0 flex-wrap items-center gap-1 border border-border bg-muted p-1 group-data-[orientation=vertical]/tabs:flex-col",
          typeof className === "function" ? className(state) : className
        )
      }
      {...props}
    >
      {children}
      <TabsPrimitive.Indicator
        data-slot="tabs-indicator"
        aria-hidden="true"
        className="pointer-events-none absolute top-0 left-0 h-(--active-tab-height) w-(--active-tab-width) [translate:var(--active-tab-left)_var(--active-tab-top)] rounded-sm bg-card shadow-(--shadow-segment) transition-[translate,width,height] duration-(--ui-motion-press) ease-(--ui-motion-ease) group-data-[motion-reduced=true]/tabs-list:transition-none motion-reduce:transition-none"
      />
    </TabsPrimitive.List>
  )
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={(state) =>
        cn(
          "relative z-1 inline-flex min-h-11 min-w-11 flex-auto items-center justify-center gap-2 rounded-sm px-4 py-2 text-base leading-5 text-foreground transition-[background-color] duration-(--ui-motion-fast) ease-(--ui-motion-ease) outline-none focus-visible:shadow-(--shadow-focus) enabled:not-data-active:hover:bg-(--control-hover) disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none data-active:font-medium forced-colors:data-active:outline-2 forced-colors:data-active:-outline-offset-2 forced-colors:data-active:outline-[Highlight] forced-colors:data-active:outline-solid [&_svg]:size-4 [&_svg]:shrink-0",
          typeof className === "function" ? className(state) : className
        )
      }
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={(state) =>
        cn(
          "min-w-0 flex-1 rounded-md text-base leading-5 outline-none focus-visible:shadow-(--shadow-focus)",
          typeof className === "function" ? className(state) : className
        )
      }
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
