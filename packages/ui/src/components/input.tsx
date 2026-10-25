"use client"

import { Input as InputPrimitive } from "@base-ui/react/input"
import { cn } from "cn"

const inputStyles =
  "min-h-11 w-full min-w-0 rounded-[10px] border border-input bg-card px-3 py-2 text-md leading-[1.5rem] text-foreground outline-none placeholder:text-muted-foreground transition-[border-color,box-shadow] duration-150 focus-visible:border-ring focus-visible:shadow-(--shadow-focus) disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive sm:text-base sm:leading-[1.25rem] motion-reduce:transition-none file:mr-3 file:border-0 file:bg-transparent file:text-base file:font-medium file:text-foreground"

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
