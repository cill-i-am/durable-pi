"use client"

import { Input as InputPrimitive } from "@base-ui/react/input"
import { cn } from "cn"

const inputStyles =
  "min-h-11 md:pointer-fine:not-any-pointer-coarse:min-h-9 md:pointer-fine:not-any-pointer-coarse:py-1.5 w-full min-w-0 rounded-control border border-input bg-card px-3 py-2 text-md text-card-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:shadow-(--shadow-focus) disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive md:pointer-fine:not-any-pointer-coarse:text-base md:pointer-fine:not-any-pointer-coarse:leading-5 file:mr-3 file:border-0 file:bg-transparent file:text-base file:font-medium file:text-card-foreground"

function Input({ className, type, ...props }: InputPrimitive.Props) {
  return (
    <InputPrimitive
      data-slot="input"
      type={type}
      className={(state) =>
        cn(
          inputStyles,
          typeof className === "function" ? className(state) : className
        )
      }
      {...props}
    />
  )
}

export { Input }
