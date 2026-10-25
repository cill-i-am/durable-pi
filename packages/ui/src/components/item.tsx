"use client"

import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { useUIReducedMotion } from "@workspace/ui/hooks/use-ui-reduced-motion"
import { cn } from "@workspace/ui/lib/utils"
import { cva, type VariantProps } from "class-variance-authority"
import * as React from "react"

import { Separator } from "./separator"

const ItemGroupContext = React.createContext(false)

function ItemGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <ItemGroupContext.Provider value={true}>
      <div
        role="list"
        data-slot="item-group"
        className={cn("flex min-w-0 flex-col", className)}
        {...props}
      />
    </ItemGroupContext.Provider>
  )
}

function ItemSeparator({
  className,
  ...props
}: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="item-separator"
      role="presentation"
      aria-hidden="true"
      className={className}
      {...props}
    />
  )
}

const itemVariants = cva(
  "group/item flex w-full min-w-0 flex-wrap items-center gap-3 text-base/[1.25rem] transition-[background-color] duration-(--ui-motion-fast) ease-(--ui-motion-ease) outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background aria-disabled:opacity-50 data-[motion-reduced=true]:transition-none motion-reduce:transition-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "rounded-[10px] border border-border",
        muted: "rounded-[10px] bg-muted",
        selected: "rounded-[10px] bg-accent text-primary",
      },
      size: {
        default: "min-h-15 px-3 py-2",
        sm: "min-h-11 px-3 py-2",
        xs: "min-h-10 px-2.5 py-1.5",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
)

function Item({
  className,
  variant = "default",
  size = "default",
  render,
  ...props
}: useRender.ComponentProps<"div"> & VariantProps<typeof itemVariants>) {
  const inList = React.useContext(ItemGroupContext)
  const reduced = useUIReducedMotion()
  const row = useRender({
    defaultTagName: "div",
    render,
    props: mergeProps<"div">(
      {
        className: cn(itemVariants({ variant, size }), className),
      },
      props
    ),
    state: {
      slot: "item",
      variant,
      size,
      "motion-reduced": reduced ? "true" : undefined,
    },
  })
  // Keep link/button semantics on polymorphic rows while owning the list item outside them.
  return inList ? (
    <div role="listitem" data-slot="item-list-entry" className="min-w-0">
      {row}
    </div>
  ) : (
    row
  )
}

function ItemMedia({
  className,
  variant = "icon",
  ...props
}: React.ComponentProps<"div"> & { variant?: "default" | "icon" | "image" }) {
  return (
    <div
      data-slot="item-media"
      data-variant={variant}
      className={cn(
        "flex w-6 shrink-0 items-center justify-center text-muted-foreground data-[variant=image]:size-9 data-[variant=image]:overflow-hidden data-[variant=image]:rounded-[6px] [&_img]:size-full [&_img]:object-cover [&_svg]:size-[18px] [&_svg]:shrink-0",
        className
      )}
      {...props}
    />
  )
}

function ItemContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-content"
      className={cn("flex min-w-0 flex-1 flex-col gap-0.5", className)}
      {...props}
    />
  )
}

function ItemTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-title"
      className={cn(
        "min-w-0 text-base/[1.25rem] font-medium wrap-anywhere",
        className
      )}
      {...props}
    />
  )
}

function ItemDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="item-description"
      className={cn(
        "min-w-0 text-sm/[1.25rem] wrap-anywhere text-muted-foreground [&_a]:underline [&_a]:underline-offset-4",
        className
      )}
      {...props}
    />
  )
}

function ItemActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-actions"
      className={cn(
        "flex max-w-full min-w-0 shrink-0 flex-wrap items-center justify-end gap-2",
        className
      )}
      {...props}
    />
  )
}

function ItemHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-header"
      className={cn(
        "flex min-w-0 basis-full flex-wrap items-center justify-between gap-2",
        className
      )}
      {...props}
    />
  )
}

function ItemFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-footer"
      className={cn(
        "flex min-w-0 basis-full flex-wrap items-center justify-between gap-2 text-sm/[1.25rem] text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Item,
  ItemGroup,
  ItemSeparator,
  ItemMedia,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
  ItemHeader,
  ItemFooter,
  itemVariants,
}
