"use client"

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox"
import { BaseMotionSpan } from "@workspace/ui/components/base-motion-span"
import { IconSwap } from "@workspace/ui/components/icon-swap"
import { useUIReducedMotion } from "@workspace/ui/hooks/use-ui-reduced-motion"
import { motionSpring } from "@workspace/ui/lib/motion"
import { cn } from "cn"
import { CheckIcon, MinusIcon } from "lucide-react"

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  const reduced = useUIReducedMotion()
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      data-motion-reduced={reduced ? "true" : undefined}
      className={(state) =>
        cn(
          "peer relative inline-flex size-[1.125rem] shrink-0 items-center justify-center rounded-[5px] border border-input bg-card text-primary-foreground outline-none after:absolute after:-inset-[13px] focus-visible:border-ring focus-visible:shadow-(--shadow-focus) aria-invalid:border-destructive data-indeterminate:border-primary data-indeterminate:bg-primary data-checked:border-primary data-checked:bg-primary data-disabled:cursor-not-allowed data-disabled:opacity-50",
          typeof className === "function" ? className(state) : className
        )
      }
      {...props}
    >
      <CheckboxPrimitive.Indicator
        keepMounted
        data-slot="checkbox-indicator"
        className="pointer-events-none flex items-center justify-center opacity-0 transition-opacity duration-(--ui-motion-fast) ease-(--ui-motion-ease) data-indeterminate:opacity-100 data-checked:opacity-100 [&_svg]:size-3.5"
        render={(baseProps, state) => {
          const visible = state.checked || state.indeterminate
          const still = reduced || state.disabled
          return (
            <BaseMotionSpan
              baseProps={{
                ...baseProps,
                "aria-hidden": true,
                children: (
                  <IconSwap
                    active={state.indeterminate}
                    activeIcon={<MinusIcon aria-hidden="true" />}
                    inactiveIcon={<CheckIcon aria-hidden="true" />}
                    className="size-3.5"
                  />
                ),
              }}
              initial={false}
              className={still ? "[transform:none]! [filter:none]!" : undefined}
              transformTemplate={still ? () => "none" : undefined}
              animate={{
                scale: still ? 1 : visible ? 1 : 0.25,
                filter: still || visible ? "blur(0px)" : "blur(4px)",
              }}
              transition={still ? { duration: 0 } : motionSpring}
            />
          )
        }}
      />
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
