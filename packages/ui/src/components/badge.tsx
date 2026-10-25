import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cn } from "@workspace/ui/lib/utils"
import { cva, type VariantProps } from "class-variance-authority"
import type * as React from "react"

const badgeVariants = cva(
  "inline-flex min-h-6 w-fit max-w-full shrink-0 items-center justify-center gap-1.5 rounded-full border px-2 py-0.5 text-sm/[1.25rem] font-medium wrap-anywhere outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background [&>svg]:size-3.5 [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-muted text-foreground",
        outline: "border-border bg-transparent text-foreground",
        destructive: "border-transparent bg-destructive-bg text-destructive",
        ghost: "border-transparent bg-transparent text-muted-foreground",
        link: "border-transparent bg-transparent text-primary underline-offset-4 hover:underline",
      },
    },
    defaultVariants: { variant: "default" },
  }
)

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    render,
    props: mergeProps<"span">(
      { className: cn(badgeVariants({ variant }), className) },
      props
    ),
    state: { slot: "badge", variant },
  })
}

function Status({
  className,
  tone = "default",
  ...props
}: React.ComponentProps<"span"> & {
  tone?: "default" | "warning" | "destructive"
}) {
  return (
    <span
      data-slot="status"
      data-tone={tone}
      className={cn(
        "inline-flex min-w-0 items-center gap-2 text-sm/[1.25rem] font-medium text-foreground data-[tone=destructive]:text-destructive data-[tone=warning]:text-warning [&>svg]:size-[18px] [&>svg]:shrink-0",
        className
      )}
      {...props}
    />
  )
}

export { Badge, Status, badgeVariants }
