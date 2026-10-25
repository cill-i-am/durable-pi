"use client"

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
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

function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={(state) =>
        cn(
          "inline-flex w-fit max-w-full min-w-0 flex-wrap items-center gap-1 rounded-[10px] border border-border bg-muted p-1 group-data-[orientation=vertical]/tabs:flex-col",
          typeof className === "function" ? className(state) : className
        )
      }
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={(state) =>
        cn(
          "inline-flex min-h-11 min-w-11 flex-auto items-center justify-center gap-2 rounded-[6px] px-4 py-2 text-base leading-[1.25rem] text-foreground transition-[background-color] duration-(--ui-motion-fast) ease-(--ui-motion-ease) outline-none focus-visible:shadow-(--shadow-focus) enabled:hover:bg-(--control-hover) disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none data-active:bg-card data-active:font-medium data-active:shadow-(--shadow-segment) data-active:focus-visible:[box-shadow:var(--shadow-segment),var(--shadow-focus)] [&_svg]:size-4 [&_svg]:shrink-0",
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
          "min-w-0 flex-1 rounded-[10px] text-base leading-[1.25rem] outline-none focus-visible:shadow-(--shadow-focus)",
          typeof className === "function" ? className(state) : className
        )
      }
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
