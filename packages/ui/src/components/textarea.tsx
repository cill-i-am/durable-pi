import { cn } from "cn"
import type { ComponentProps } from "react"

function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "rounded-control block min-h-24 w-full min-w-0 resize-y border border-input bg-card px-3 py-2 text-md text-card-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:shadow-(--shadow-focus) disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive md:pointer-fine:not-any-pointer-coarse:text-base md:pointer-fine:not-any-pointer-coarse:leading-5",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
