"use client"

import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { useUIReducedMotion } from "@workspace/ui/hooks/use-ui-reduced-motion"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

const buttonVariants = cva(
  "inline-flex min-h-11 max-w-full shrink-0 items-center justify-center gap-2 rounded-[10px] border border-transparent px-3 py-2 text-center text-base leading-[1.25rem] font-medium [overflow-wrap:anywhere] transition-[background-color,scale] duration-(--ui-motion-press) ease-out outline-none select-none [-webkit-tap-highlight-color:transparent] focus-visible:[box-shadow:var(--shadow-button),var(--shadow-focus)] disabled:pointer-events-none disabled:opacity-50 disabled:aria-busy:opacity-100 aria-invalid:border-destructive motion-reduce:transition-none data-disabled:pointer-events-none data-disabled:opacity-50 data-disabled:aria-busy:opacity-100 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border-primary bg-primary bg-[image:var(--gradient-button)] text-primary-foreground shadow-(--shadow-button) not-disabled:hover:bg-[image:var(--gradient-button-hover)] not-disabled:active:bg-[image:var(--gradient-button-pressed)] not-disabled:active:shadow-(--shadow-button-pressed) not-disabled:active:focus-visible:[box-shadow:var(--shadow-button-pressed),var(--shadow-focus)]",
        outline:
          "border-input bg-card bg-[image:var(--gradient-outline)] text-foreground shadow-(--shadow-button) not-disabled:hover:bg-[image:linear-gradient(var(--control-hover),var(--control-hover))] not-disabled:active:bg-[image:var(--gradient-button-pressed)] not-disabled:active:shadow-(--shadow-button-pressed) not-disabled:active:focus-visible:[box-shadow:var(--shadow-button-pressed),var(--shadow-focus)]",
        secondary:
          "border-border bg-muted bg-[image:var(--gradient-secondary)] text-foreground shadow-(--shadow-button) not-disabled:hover:bg-[image:linear-gradient(var(--control-hover),var(--control-hover))] not-disabled:active:bg-[image:var(--gradient-button-pressed)] not-disabled:active:shadow-(--shadow-button-pressed) not-disabled:active:focus-visible:[box-shadow:var(--shadow-button-pressed),var(--shadow-focus)]",
        destructive:
          "border-(--destructive-fill) bg-(--destructive-fill) bg-[image:var(--gradient-button)] text-destructive-foreground shadow-(--shadow-button) not-disabled:hover:bg-[image:var(--gradient-button-hover)] not-disabled:active:bg-[image:var(--gradient-button-pressed)] not-disabled:active:shadow-(--shadow-button-pressed) not-disabled:active:focus-visible:[box-shadow:var(--shadow-button-pressed),var(--shadow-focus)]",
        ghost:
          "bg-transparent text-foreground not-disabled:hover:bg-(--control-hover) focus-visible:[box-shadow:var(--shadow-focus)] not-disabled:active:bg-(--control-hover)",
        link: "bg-transparent text-primary underline-offset-4 not-disabled:hover:underline focus-visible:[box-shadow:var(--shadow-focus)]",
      },
      size: {
        default: "",
        sm: "px-2.5 text-sm",
        lg: "min-h-12 px-5 text-md leading-[1.5rem]",
        icon: "size-11 p-0",
        "icon-sm": "size-11 p-0 [&_svg]:size-4",
        "icon-lg": "size-12 p-0 [&_svg]:size-5",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
)

type ButtonProps = ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants> & {
    /** Keep native press feedback without moving the control. */
    static?: boolean
  }

function Button({
  className,
  variant,
  size,
  static: isStatic = false,
  ...props
}: ButtonProps) {
  const reduced = useUIReducedMotion()
  return (
    <ButtonPrimitive
      data-slot="button"
      data-variant={variant ?? "default"}
      data-size={size ?? "default"}
      data-static={isStatic}
      data-motion-reduced={reduced ? "true" : undefined}
      className={(state) =>
        cn(
          buttonVariants({ variant, size }),
          !reduced &&
            !isStatic &&
            !state.disabled &&
            "motion-safe:active:scale-[0.96]",
          (reduced || state.disabled) && "transition-none",
          typeof className === "function" ? className(state) : className
        )
      }
      {...props}
    />
  )
}

export { Button, buttonVariants }
export type { ButtonProps }
