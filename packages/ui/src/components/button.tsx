"use client"

import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { useUIReducedMotion } from "@workspace/ui/hooks/use-ui-reduced-motion"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

const buttonStyles = cva(
  "inline-flex min-h-11 max-w-full shrink-0 items-center justify-center gap-2 rounded-control border border-transparent px-3 py-2 text-center text-base leading-5 font-medium [overflow-wrap:anywhere] transition-[background-color,scale] duration-(--ui-motion-press) ease-out outline-none select-none [-webkit-tap-highlight-color:transparent] focus-visible:[box-shadow:var(--shadow-button),var(--shadow-focus)] disabled:pointer-events-none disabled:opacity-50 disabled:transition-none disabled:aria-busy:opacity-100 aria-invalid:border-destructive data-[motion-reduced=true]:transition-none motion-safe:not-disabled:not-data-disabled:not-data-[static=true]:not-data-[motion-reduced=true]:active:scale-[0.96] motion-reduce:transition-none md:pointer-fine:not-any-pointer-coarse:min-h-9 md:pointer-fine:not-any-pointer-coarse:py-1.5 data-disabled:pointer-events-none data-disabled:opacity-50 data-disabled:transition-none data-disabled:aria-busy:opacity-100 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border-primary bg-primary bg-[image:var(--gradient-button)] text-primary-foreground shadow-(--shadow-button) not-disabled:hover:bg-[image:var(--gradient-button-hover)] not-disabled:active:bg-[image:var(--gradient-button-pressed)] not-disabled:active:shadow-(--shadow-button-pressed) not-disabled:active:focus-visible:[box-shadow:var(--shadow-button-pressed),var(--shadow-focus)]",
        outline:
          "border-input bg-card bg-[image:var(--gradient-outline)] text-card-foreground shadow-(--shadow-button) not-disabled:hover:bg-[image:linear-gradient(var(--accent),var(--accent))] not-disabled:hover:text-accent-foreground not-disabled:active:bg-[image:var(--gradient-button-pressed)] not-disabled:active:text-card-foreground not-disabled:active:shadow-(--shadow-button-pressed) not-disabled:active:focus-visible:[box-shadow:var(--shadow-button-pressed),var(--shadow-focus)]",
        secondary:
          "border-border bg-secondary bg-[image:var(--gradient-secondary)] text-secondary-foreground shadow-(--shadow-button) not-disabled:hover:bg-[image:linear-gradient(var(--accent),var(--accent))] not-disabled:hover:text-accent-foreground not-disabled:active:bg-[image:var(--gradient-button-pressed)] not-disabled:active:text-secondary-foreground not-disabled:active:shadow-(--shadow-button-pressed) not-disabled:active:focus-visible:[box-shadow:var(--shadow-button-pressed),var(--shadow-focus)]",
        destructive:
          "border-(--destructive-fill) bg-(--destructive-fill) bg-[image:var(--gradient-button)] text-destructive-foreground shadow-(--shadow-button) not-disabled:hover:bg-[image:var(--gradient-button-hover)] not-disabled:active:bg-[image:var(--gradient-button-pressed)] not-disabled:active:shadow-(--shadow-button-pressed) not-disabled:active:focus-visible:[box-shadow:var(--shadow-button-pressed),var(--shadow-focus)]",
        ghost:
          "bg-transparent text-foreground not-disabled:hover:bg-accent not-disabled:hover:text-accent-foreground focus-visible:[box-shadow:var(--shadow-focus)] not-disabled:active:bg-accent not-disabled:active:text-accent-foreground",
        link: "bg-transparent text-primary underline-offset-4 not-disabled:hover:underline focus-visible:[box-shadow:var(--shadow-focus)]",
      },
      size: {
        default: "",
        xs: "px-2.5 text-sm md:pointer-fine:not-any-pointer-coarse:min-h-8 md:pointer-fine:not-any-pointer-coarse:py-1",
        sm: "px-2.5 text-sm md:pointer-fine:not-any-pointer-coarse:min-h-8 md:pointer-fine:not-any-pointer-coarse:py-1",
        lg: "min-h-12 px-5 text-md md:pointer-fine:not-any-pointer-coarse:min-h-11 md:pointer-fine:not-any-pointer-coarse:py-2",
        icon: "size-11 p-0 md:pointer-fine:not-any-pointer-coarse:size-9 md:pointer-fine:not-any-pointer-coarse:p-0",
        "icon-xs":
          "size-11 p-0 md:pointer-fine:not-any-pointer-coarse:size-8 md:pointer-fine:not-any-pointer-coarse:min-h-8 md:pointer-fine:not-any-pointer-coarse:p-0 [&_svg]:size-4",
        "icon-sm":
          "size-11 p-0 md:pointer-fine:not-any-pointer-coarse:size-8 md:pointer-fine:not-any-pointer-coarse:min-h-8 md:pointer-fine:not-any-pointer-coarse:p-0 [&_svg]:size-4",
        "icon-lg":
          "size-12 p-0 md:pointer-fine:not-any-pointer-coarse:size-11 md:pointer-fine:not-any-pointer-coarse:min-h-11 md:pointer-fine:not-any-pointer-coarse:p-0 [&_svg]:size-5",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
)

const buttonVariants: typeof buttonStyles = (props) => cn(buttonStyles(props))

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
        buttonVariants({
          variant,
          size,
          className:
            typeof className === "function" ? className(state) : className,
        })
      }
      {...props}
    />
  )
}

export { Button, buttonVariants }
export type { ButtonProps }
