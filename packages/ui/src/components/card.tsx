import { cn } from "@workspace/ui/lib/utils"
import { cva, type VariantProps } from "class-variance-authority"
import type * as React from "react"

function CardFrame({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-frame"
      className={cn(
        "bg-surface-underlay rounded-frame @container/card-frame flex min-w-0 flex-col gap-[3px] border border-border p-[3px] text-card-foreground shadow-(--shadow-card-frame)",
        className
      )}
      {...props}
    />
  )
}

function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "@container/card flex min-w-0 flex-col rounded-md border border-border bg-card text-base/5 text-card-foreground shadow-(--shadow-card)",
        className
      )}
      {...props}
    />
  )
}

function CardPanel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-panel"
      className={cn(
        "flex min-w-0 flex-col rounded-md border border-border bg-card text-base/5 text-card-foreground",
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 pt-4 pb-2 @max-[18rem]/card:grid-cols-1",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"h3">) {
  return (
    <h3
      data-slot="card-title"
      className={cn("min-w-0 text-md font-semibold wrap-anywhere", className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="card-description"
      className={cn(
        "col-start-1 min-w-0 text-sm wrap-anywhere text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-1 row-start-1 flex min-w-0 flex-wrap items-center gap-2 justify-self-end group-has-data-[slot=card-description]/card-header:row-span-2 @max-[18rem]/card:col-start-1 @max-[18rem]/card:row-span-1 @max-[18rem]/card:row-start-auto @max-[18rem]/card:justify-self-start",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("min-w-0 p-3", className)}
      {...props}
    />
  )
}

const footerVariants = cva(
  "flex min-w-0 flex-wrap items-center gap-2 px-3 py-3 text-sm text-muted-foreground [&>[data-slot=button]]:max-w-full",
  {
    variants: {
      variant: {
        context: "min-h-14",
        actions: "min-h-18 justify-end",
        split: "min-h-18 justify-between",
      },
    },
    defaultVariants: { variant: "context" },
  }
)

function CardFooter({
  className,
  variant = "context",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof footerVariants>) {
  return (
    <div
      data-slot="card-footer"
      data-variant={variant}
      className={cn(
        footerVariants({ variant }),
        "bg-surface-underlay rounded-b-[inherit] border-t border-border",
        className
      )}
      {...props}
    />
  )
}

function CardFrameHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-frame-header"
      className={cn(
        "group/card-frame-header grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-3 py-2 @max-[18rem]/card-frame:grid-cols-1",
        className
      )}
      {...props}
    />
  )
}

function CardFrameTitle({ className, ...props }: React.ComponentProps<"h3">) {
  return (
    <h3
      data-slot="card-frame-title"
      className={cn("min-w-0 text-md font-semibold wrap-anywhere", className)}
      {...props}
    />
  )
}

function CardFrameDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="card-frame-description"
      className={cn(
        "col-start-1 min-w-0 text-sm wrap-anywhere text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function CardFrameAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-frame-action"
      className={cn(
        "col-start-2 row-span-1 row-start-1 flex min-w-0 flex-wrap items-center gap-2 justify-self-end group-has-data-[slot=card-frame-description]/card-frame-header:row-span-2 @max-[18rem]/card-frame:col-start-1 @max-[18rem]/card-frame:row-span-1 @max-[18rem]/card-frame:row-start-auto @max-[18rem]/card-frame:justify-self-start",
        className
      )}
      {...props}
    />
  )
}

function CardFrameFooter({
  className,
  variant = "context",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof footerVariants>) {
  return (
    <div
      data-slot="card-frame-footer"
      data-variant={variant}
      className={cn(footerVariants({ variant }), className)}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
  CardFooter,
  CardFrame,
  CardFrameHeader,
  CardFrameTitle,
  CardFrameDescription,
  CardFrameAction,
  CardFrameFooter,
  CardPanel,
}
