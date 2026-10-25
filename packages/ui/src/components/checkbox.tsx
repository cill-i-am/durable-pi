"use client"

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox"
import { cn } from "cn"
import { CheckIcon, MinusIcon } from "lucide-react"

function Checkbox({
  className,
  indeterminate,
  ...props
}: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      indeterminate={indeterminate}
      className={(state) =>
        cn(
          "peer relative inline-flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border border-input bg-card text-primary-foreground transition-[background-color,box-shadow] duration-150 outline-none after:absolute after:-inset-[13px] focus-visible:border-ring focus-visible:shadow-(--shadow-focus) aria-invalid:border-destructive data-indeterminate:border-primary data-indeterminate:bg-primary motion-reduce:transition-none data-checked:border-primary data-checked:bg-primary data-disabled:cursor-not-allowed data-disabled:opacity-50",
          typeof className === "function" ? className(state) : className
        )
      }
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center [&_svg]:size-3.5"
      >
        {indeterminate ? (
          <MinusIcon aria-hidden="true" />
        ) : (
          <CheckIcon aria-hidden="true" />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
