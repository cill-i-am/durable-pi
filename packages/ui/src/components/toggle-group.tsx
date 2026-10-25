"use client"

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group"
import { cn } from "cn"

function ToggleGroup<Value extends string>({
  className,
  ...props
}: ToggleGroupPrimitive.Props<Value>) {
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      className={(state) =>
        cn(
          "inline-flex w-fit max-w-full flex-wrap items-center gap-0.5 rounded-[10px] border border-input bg-muted p-[3px] data-[orientation=vertical]:flex-col data-disabled:opacity-50",
          typeof className === "function" ? className(state) : className
        )
      }
      {...props}
    />
  )
}

function ToggleGroupItem<Value extends string>({
  className,
  ...props
}: TogglePrimitive.Props<Value>) {
  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      className={(state) =>
        cn(
          "inline-flex min-h-11 min-w-11 flex-1 items-center justify-center gap-2 rounded-[6px] px-3 py-2 text-base leading-[1.25rem] text-foreground transition-[background-color,box-shadow] duration-150 outline-none focus-visible:shadow-(--shadow-focus) enabled:hover:bg-(--control-hover) disabled:pointer-events-none disabled:opacity-50 data-pressed:bg-card data-pressed:font-medium data-pressed:shadow-(--shadow-segment) data-pressed:focus-visible:[box-shadow:var(--shadow-segment),var(--shadow-focus)] motion-reduce:transition-none [&_svg]:size-4 [&_svg]:shrink-0",
          typeof className === "function" ? className(state) : className
        )
      }
      {...props}
    />
  )
}

export { ToggleGroup, ToggleGroupItem }
