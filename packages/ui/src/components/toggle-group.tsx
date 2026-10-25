"use client"

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group"
import { useRender, type HTMLProps } from "@base-ui/react/use-render"
import { useUIReducedMotion } from "@workspace/ui/hooks/use-ui-reduced-motion"
import { motionEase, motionFastSpring } from "@workspace/ui/lib/motion"
import { cn } from "cn"
import { AnimatePresence, LayoutGroup, motion } from "motion/react"
import { createContext, useContext, useId } from "react"

const ToggleMotionContext = createContext<{ single: boolean } | null>(null)

function ToggleGroup<Value extends string>({
  className,
  multiple = false,
  ...props
}: ToggleGroupPrimitive.Props<Value>) {
  const groupId = useId()
  return (
    <ToggleMotionContext.Provider value={{ single: !multiple }}>
      <LayoutGroup id={groupId}>
        <ToggleGroupPrimitive
          data-slot="toggle-group"
          multiple={multiple}
          className={(state) =>
            cn(
              "inline-flex w-fit max-w-full flex-wrap items-center gap-0.5 rounded-[10px] border border-input bg-muted p-[3px] data-[orientation=vertical]:flex-col data-disabled:opacity-50",
              typeof className === "function" ? className(state) : className
            )
          }
          {...props}
        />
      </LayoutGroup>
    </ToggleMotionContext.Provider>
  )
}

function ToggleIndicator({ disabled }: { disabled: boolean }) {
  const reduced = useUIReducedMotion()
  const still = reduced || disabled
  return (
    <motion.span
      aria-hidden="true"
      data-slot="toggle-group-indicator"
      data-motion-reduced={reduced ? "true" : undefined}
      layoutId={still ? undefined : "selection"}
      transformTemplate={still ? () => "none" : undefined}
      initial={still ? { opacity: 0 } : false}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={
        still ? { duration: 0.1, ease: motionEase } : motionFastSpring
      }
      className={cn(
        "pointer-events-none absolute inset-0 rounded-[6px] bg-card shadow-(--shadow-segment)",
        still && "[transform:none]!"
      )}
    />
  )
}

function ToggleElement({
  baseProps,
  state,
  render,
  single,
}: {
  baseProps: HTMLProps<HTMLButtonElement>
  state: TogglePrimitive.State
  render: TogglePrimitive.Props<string>["render"]
  single: boolean
}) {
  return useRender({
    defaultTagName: "button",
    render,
    state: { ...state },
    props: {
      ...baseProps,
      children: single ? (
        <>
          <AnimatePresence initial={false}>
            {state.pressed && (
              <ToggleIndicator key="selection" disabled={state.disabled} />
            )}
          </AnimatePresence>
          <span className="relative">{baseProps.children}</span>
        </>
      ) : (
        baseProps.children
      ),
    },
  })
}

function ToggleGroupItem<Value extends string>({
  className,
  render,
  ...props
}: TogglePrimitive.Props<Value>) {
  const context = useContext(ToggleMotionContext)
  const reduced = useUIReducedMotion()
  const single = context?.single ?? false
  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      data-motion-reduced={reduced ? "true" : undefined}
      className={(state) =>
        cn(
          "relative isolate inline-flex min-h-11 min-w-11 flex-1 items-center justify-center gap-2 rounded-[6px] px-3 py-2 text-base leading-[1.25rem] text-foreground transition-[background-color] duration-(--ui-motion-fast) ease-(--ui-motion-ease) outline-none focus-visible:shadow-(--shadow-focus) enabled:hover:bg-(--control-hover) disabled:pointer-events-none disabled:opacity-50 data-pressed:font-medium motion-reduce:transition-none [&_svg]:size-4 [&_svg]:shrink-0",
          !single &&
            "data-pressed:bg-card data-pressed:shadow-(--shadow-segment) data-pressed:focus-visible:[box-shadow:var(--shadow-segment),var(--shadow-focus)]",
          typeof className === "function" ? className(state) : className
        )
      }
      render={(baseProps, state) => (
        <ToggleElement
          baseProps={baseProps}
          state={state}
          render={render}
          single={single}
        />
      )}
      {...props}
    />
  )
}

export { ToggleGroup, ToggleGroupItem }
