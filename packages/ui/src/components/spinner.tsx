import { cn } from "cn"
import type { ComponentProps } from "react"

function Spinner({ className, ...props }: ComponentProps<"svg">) {
  return (
    <svg
      data-slot="spinner"
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      className={cn(
        "size-4 shrink-0 animate-spin text-current motion-reduce:animate-none",
        className
      )}
      {...props}
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="2"
        opacity="0.25"
      />
      <path
        d="M12 3a9 9 0 0 1 9 9"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}

export { Spinner }
