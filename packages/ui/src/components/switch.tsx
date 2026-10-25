"use client"

import { Switch as SwitchPrimitive } from "@base-ui/react/switch"
import { cn } from "cn"

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={(state) =>
        cn(
          "peer relative inline-flex h-[22px] w-9 shrink-0 items-center rounded-full border border-input bg-card p-0.5 shadow-(--shadow-switch-track) transition-[background-color,box-shadow] duration-150 outline-none after:absolute after:-inset-x-1 after:-inset-y-[11px] focus-visible:border-ring focus-visible:[box-shadow:var(--shadow-switch-track),var(--shadow-focus)] aria-invalid:border-destructive motion-reduce:transition-none data-checked:border-primary data-checked:bg-primary data-disabled:cursor-not-allowed data-disabled:opacity-50",
          typeof className === "function" ? className(state) : className
        )
      }
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-4 rounded-full bg-muted-foreground shadow-(--shadow-switch-thumb) transition-transform duration-150 motion-reduce:transition-none data-checked:translate-x-3.5 data-checked:bg-primary-foreground rtl:data-checked:-translate-x-3.5"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
