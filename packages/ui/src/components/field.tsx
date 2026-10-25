import { Label } from "@workspace/ui/components/label"
import { Separator } from "@workspace/ui/components/separator"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import type { ComponentProps, ReactNode } from "react"

function FieldSet({ className, ...props }: ComponentProps<"fieldset">) {
  return (
    <fieldset
      data-slot="field-set"
      className={cn("flex min-w-0 flex-col gap-5", className)}
      {...props}
    />
  )
}

function FieldLegend({
  className,
  variant = "legend",
  ...props
}: ComponentProps<"legend"> & { variant?: "legend" | "label" }) {
  return (
    <legend
      data-slot="field-legend"
      className={cn(
        "mb-4 text-md leading-[1.5rem] font-semibold text-foreground",
        variant === "label" && "text-base leading-[1.25rem] font-medium",
        className
      )}
      {...props}
    />
  )
}

function FieldGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="field-group"
      className={cn(
        "@container/field-group flex w-full min-w-0 flex-col gap-6",
        className
      )}
      {...props}
    />
  )
}

const fieldVariants = cva("group/field flex min-w-0 gap-2", {
  variants: {
    orientation: {
      vertical: "flex-col",
      horizontal:
        "min-h-11 flex-row items-center [&>[data-slot=field-label]]:flex-1",
      responsive:
        "flex-col @sm/field-group:flex-row @sm/field-group:items-center @sm/field-group:[&>[data-slot=field-label]]:flex-1",
    },
  },
  defaultVariants: { orientation: "vertical" },
})

function Field({
  className,
  orientation,
  ...props
}: ComponentProps<"div"> & VariantProps<typeof fieldVariants>) {
  return (
    <div
      role="group"
      data-slot="field"
      data-orientation={orientation ?? "vertical"}
      className={cn(fieldVariants({ orientation }), className)}
      {...props}
    />
  )
}

function FieldContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="field-content"
      className={cn("flex min-w-0 flex-1 flex-col gap-1", className)}
      {...props}
    />
  )
}

function FieldLabel({ className, ...props }: ComponentProps<typeof Label>) {
  return (
    <Label
      data-slot="field-label"
      className={cn("w-fit", className)}
      {...props}
    />
  )
}

function FieldTitle({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="field-title"
      className={cn(
        "text-base leading-[1.25rem] font-medium text-foreground",
        className
      )}
      {...props}
    />
  )
}

function FieldDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      data-slot="field-description"
      className={cn(
        "text-sm leading-[1.25rem] text-muted-foreground [&_a]:underline [&_a]:underline-offset-4",
        className
      )}
      {...props}
    />
  )
}

function FieldSeparator({
  children,
  className,
  ...props
}: ComponentProps<"div"> & { children?: ReactNode }) {
  return (
    <div
      data-slot="field-separator"
      className={cn("relative flex items-center justify-center", className)}
      {...props}
    >
      <Separator />
      {children && (
        <span className="absolute bg-background px-2 text-sm leading-[1.25rem] text-muted-foreground">
          {children}
        </span>
      )}
    </div>
  )
}

function FieldError({
  className,
  children,
  errors,
  ...props
}: ComponentProps<"div"> & {
  errors?: Array<{ message?: string } | undefined>
}) {
  const messages = [
    ...new Set(
      errors?.flatMap((error) => (error?.message ? [error.message] : []))
    ),
  ]
  const content =
    children ??
    (messages.length === 1 ? (
      messages[0]
    ) : messages.length > 1 ? (
      <ul className="flex list-inside list-disc flex-col gap-1">
        {messages.map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
    ) : null)
  if (!content) return null
  return (
    <div
      role="alert"
      data-slot="field-error"
      className={cn("text-sm leading-[1.25rem] text-destructive", className)}
      {...props}
    >
      {content}
    </div>
  )
}

export {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldContent,
  FieldTitle,
}
