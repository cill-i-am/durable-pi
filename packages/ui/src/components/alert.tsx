import { cn } from "@workspace/ui/lib/utils"
import { cva, type VariantProps } from "class-variance-authority"
import type * as React from "react"

const alertVariants = cva(
  "group/alert @container/alert grid min-h-11 min-w-0 items-center gap-x-3 gap-y-1 text-base/5 has-data-[slot=alert-action]:grid-cols-[minmax(0,1fr)_auto] has-[>svg]:grid-cols-[auto_minmax(0,1fr)] has-[>svg]:has-data-[slot=alert-action]:grid-cols-[auto_minmax(0,1fr)_auto] [&>svg]:size-[18px] [&>svg]:shrink-0 has-[>svg]:[&>svg]:row-span-2",
  {
    variants: {
      variant: {
        default: "text-foreground",
        destructive: "text-destructive",
        warning: "text-warning",
      },
      appearance: {
        inline: "bg-transparent",
        panel: "rounded-md border border-border bg-card p-3",
      },
    },
    defaultVariants: { variant: "default", appearance: "inline" },
  }
)

function Alert({
  className,
  variant = "default",
  appearance = "inline",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      data-variant={variant}
      data-appearance={appearance}
      role="alert"
      className={cn(alertVariants({ variant, appearance }), className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "min-w-0 font-medium wrap-anywhere group-has-[>svg]/alert:col-start-2",
        className
      )}
      {...props}
    />
  )
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "min-w-0 text-sm wrap-anywhere group-has-[>svg]/alert:col-start-2 group-data-[variant=default]/alert:text-muted-foreground [&_a]:underline [&_a]:underline-offset-4",
        className
      )}
      {...props}
    />
  )
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 flex min-w-0 flex-wrap items-center gap-2 group-has-[>svg]/alert:col-start-3 @max-sm/alert:col-start-2 @max-sm/alert:row-span-1 @max-sm/alert:row-start-3",
        className
      )}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription, AlertAction }
