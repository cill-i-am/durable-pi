import { cn } from "cn"
import type { ComponentProps } from "react"

function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "block min-h-24 w-full min-w-0 resize-y rounded-[10px] border border-input bg-card px-3 py-2 text-md leading-[1.5rem] text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:shadow-(--shadow-focus) disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive sm:text-base sm:leading-[1.25rem]",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
