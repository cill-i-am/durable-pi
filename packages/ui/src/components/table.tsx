"use client"

import { useUIReducedMotion } from "@workspace/ui/hooks/use-ui-reduced-motion"
import { cn } from "@workspace/ui/lib/utils"
import type * as React from "react"

function Table({
  className,
  containerProps,
  ...props
}: React.ComponentProps<"table"> & {
  containerProps?: React.ComponentProps<"div">
}) {
  const { className: containerClassName, ...containerAttributes } =
    containerProps ?? {}
  return (
    <div
      data-slot="table-container"
      className={cn(
        "relative w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        containerClassName
      )}
      {...containerAttributes}
    >
      <table
        data-slot="table"
        className={cn(
          "w-full caption-bottom border-collapse text-base/5",
          className
        )}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b [&_tr]:border-border", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-b-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "bg-surface-underlay border-t border-border font-medium",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  const reduced = useUIReducedMotion()
  return (
    <tr
      data-slot="table-row"
      data-motion-reduced={reduced ? "true" : undefined}
      className={cn(
        "border-b border-border transition-[background-color] duration-(--ui-motion-fast) ease-(--ui-motion-ease) hover:bg-muted data-[motion-reduced=true]:transition-none data-[state=selected]:bg-accent motion-reduce:transition-none",
        className
      )}
      {...props}
    />
  )
}

function TableHead({
  className,
  scope = "col",
  ...props
}: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      scope={scope}
      className={cn(
        "h-11 px-3 py-2 text-left align-middle text-sm font-medium text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn("h-15 px-3 py-2 align-middle wrap-anywhere", className)}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn(
        "px-3 py-3 text-left text-sm text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
}
