"use client"

import { useDirection } from "@base-ui/react/direction-provider"
import { Switch as SwitchPrimitive } from "@base-ui/react/switch"
import { BaseMotionSpan } from "@workspace/ui/components/base-motion-span"
import { useUIReducedMotion } from "@workspace/ui/hooks/use-ui-reduced-motion"
import { motionFastSpring } from "@workspace/ui/lib/motion"
import { cn } from "cn"

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  const reduced = useUIReducedMotion()
  const inheritedDirection = useDirection()
  const direction =
    props.dir === "rtl" || props.dir === "ltr" ? props.dir : inheritedDirection
  const sign = direction === "rtl" ? "+" : "-"
  const onPosition = `calc(${direction === "rtl" ? -100 : 100}% ${sign} 2px)`
  const offPosition = `calc(0% ${sign} 0px)`
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-motion-reduced={reduced ? "true" : undefined}
      className={(state) =>
        cn(
          "peer relative inline-flex h-[1.375rem] w-9 shrink-0 items-center rounded-full border border-input bg-card p-0.5 shadow-(--shadow-switch-track) outline-none after:absolute after:-inset-x-1 after:-inset-y-[11px] focus-visible:border-ring focus-visible:[box-shadow:var(--shadow-switch-track),var(--shadow-focus)] aria-invalid:border-destructive data-checked:border-primary data-checked:bg-primary data-disabled:cursor-not-allowed data-disabled:opacity-50",
          typeof className === "function" ? className(state) : className
        )
      }
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-4 rounded-full bg-muted-foreground shadow-(--shadow-switch-thumb) data-checked:bg-primary-foreground"
        render={(baseProps, state) => (
          <BaseMotionSpan
            baseProps={baseProps}
            initial={false}
            animate={{ x: state.checked ? onPosition : offPosition }}
            transformTemplate={
              reduced || state.disabled
                ? () =>
                    `translateX(${state.checked ? onPosition : offPosition})`
                : undefined
            }
            transition={
              reduced || state.disabled ? { duration: 0 } : motionFastSpring
            }
          />
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
