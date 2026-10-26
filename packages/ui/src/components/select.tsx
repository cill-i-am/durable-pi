"use client"

import { Select as SelectPrimitive } from "@base-ui/react/select"
import {
  ResponsivePopup,
  usePopupMobile,
} from "@workspace/ui/components/responsive-popup"
import { useIsMobile } from "@workspace/ui/hooks/use-mobile"
import { useUIReducedMotion } from "@workspace/ui/hooks/use-ui-reduced-motion"
import { cn } from "cn"
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react"
import { useRef, useState, type ComponentProps } from "react"

function Select<Value, Multiple extends boolean | undefined = false>({
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  children,
  ...props
}: SelectPrimitive.Root.Props<Value, Multiple>) {
  const mobile = useIsMobile()
  const [localOpen, setLocalOpen] = useState(defaultOpen)
  const open = controlledOpen ?? localOpen
  const localActions = useRef<SelectPrimitive.Root.Actions>(null)
  const actions = props.actionsRef ?? localActions
  return (
    <SelectPrimitive.Root
      {...props}
      actionsRef={actions}
      open={open}
      modal={mobile ? false : props.modal}
      onOpenChange={(next, details) => {
        if (
          mobile &&
          ["outside-press", "window-resize", "cancel-open"].includes(
            details.reason
          )
        ) {
          details.cancel()
          return
        }
        onOpenChange?.(next, details)
        if (!details.isCanceled) setLocalOpen(next)
      }}
    >
      <ResponsivePopup.Root
        open={open}
        onTabOut={() => actions.current?.close()}
        onOpenChange={(next, details) => {
          onOpenChange?.(next, { ...details, reason: "none" })
          if (!details.isCanceled) setLocalOpen(next)
        }}
      >
        {children}
      </ResponsivePopup.Root>
    </SelectPrimitive.Root>
  )
}

function SelectGroup({ className, ...props }: SelectPrimitive.Group.Props) {
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      className={(state) =>
        cn(
          "scroll-my-1",
          typeof className === "function" ? className(state) : className
        )
      }
      {...props}
    />
  )
}

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={(state) =>
        cn(
          "min-w-0 flex-1 text-start [overflow-wrap:anywhere]",
          typeof className === "function" ? className(state) : className
        )
      }
      {...props}
    />
  )
}

function SelectTrigger({
  className,
  children,
  ...props
}: SelectPrimitive.Trigger.Props) {
  return (
    <ResponsivePopup.Trigger>
      <SelectPrimitive.Trigger
        data-slot="select-trigger"
        className={(state) =>
          cn(
            "rounded-control flex min-h-11 w-full min-w-0 items-center justify-between gap-2 border border-input bg-card px-3 py-2 text-md text-card-foreground outline-none focus-visible:border-ring focus-visible:shadow-(--shadow-focus) disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive data-placeholder:text-muted-foreground md:pointer-fine:not-any-pointer-coarse:min-h-9 md:pointer-fine:not-any-pointer-coarse:py-1.5 md:pointer-fine:not-any-pointer-coarse:text-base md:pointer-fine:not-any-pointer-coarse:leading-5 [&_svg]:size-4 [&_svg]:shrink-0",
            typeof className === "function" ? className(state) : className
          )
        }
        {...props}
      >
        {children}
        <SelectPrimitive.Icon render={<ChevronDownIcon aria-hidden="true" />} />
      </SelectPrimitive.Trigger>
    </ResponsivePopup.Trigger>
  )
}

type SelectContentProps = SelectPrimitive.Popup.Props &
  Pick<
    SelectPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset" | "alignItemWithTrigger"
  > & { mobileTitle?: string }

function SelectContent({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "start",
  alignOffset = 0,
  alignItemWithTrigger = false,
  mobileTitle = "Choose an option",
  ...props
}: SelectContentProps) {
  const mobile = usePopupMobile()
  const reducedMotion = useUIReducedMotion()
  if (mobile)
    return (
      <ResponsivePopup.Content
        title={mobileTitle}
        finalFocus={props.finalFocus}
      >
        <SelectPrimitive.Positioner
          alignItemWithTrigger={false}
          className="responsive-popup-positioner"
        >
          <SelectPrimitive.Popup
            {...props}
            finalFocus={false}
            data-slot="select-content"
            className={(state) =>
              cn(
                "responsive-popup-content",
                typeof className === "function" ? className(state) : className
              )
            }
          >
            <SelectPrimitive.List>{children}</SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </ResponsivePopup.Content>
    )
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        alignItemWithTrigger={alignItemWithTrigger}
        className="isolate"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          data-motion-reduced={reducedMotion ? "true" : undefined}
          className={(state) =>
            cn(
              "ui-floating-popup max-h-(--available-height) w-(--anchor-width) min-w-40 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-(--shadow-menu) outline-none",
              typeof className === "function" ? className(state) : className
            )
          }
          {...props}
        >
          <SelectScrollUpButton />
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
          <SelectScrollDownButton />
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  )
}

function SelectLabel({
  className,
  ...props
}: SelectPrimitive.GroupLabel.Props) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-label"
      className={(state) =>
        cn(
          "px-3 py-2 text-sm text-muted-foreground",
          typeof className === "function" ? className(state) : className
        )
      }
      {...props}
    />
  )
}

function SelectItem({
  className,
  children,
  ...props
}: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={(state) =>
        cn(
          "relative flex min-h-11 w-full cursor-default items-center gap-2 rounded-sm py-2 ps-3 pe-9 text-md text-foreground outline-none select-none focus-visible:[box-shadow:inset_0_0_0_2px_var(--ring)] data-highlighted:bg-accent data-highlighted:text-accent-foreground md:text-popover-foreground md:pointer-fine:not-any-pointer-coarse:min-h-9 md:pointer-fine:not-any-pointer-coarse:py-1.5 md:pointer-fine:not-any-pointer-coarse:text-base md:pointer-fine:not-any-pointer-coarse:leading-5 data-disabled:pointer-events-none data-disabled:opacity-50",
          typeof className === "function" ? className(state) : className
        )
      }
      {...props}
    >
      <SelectPrimitive.ItemText className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        {children}
      </SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute end-3 flex size-4 items-center justify-center">
        <CheckIcon className="size-4" aria-hidden="true" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  )
}

function SelectSeparator({
  className,
  ...props
}: SelectPrimitive.Separator.Props) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={(state) =>
        cn(
          "my-1 h-px bg-border",
          typeof className === "function" ? className(state) : className
        )
      }
      {...props}
    />
  )
}

function SelectScrollUpButton({
  className,
  ...props
}: ComponentProps<typeof SelectPrimitive.ScrollUpArrow>) {
  return (
    <SelectPrimitive.ScrollUpArrow
      data-slot="select-scroll-up-button"
      className={(state) =>
        cn(
          "flex min-h-11 items-center justify-center bg-popover text-popover-foreground md:pointer-fine:not-any-pointer-coarse:min-h-9 md:pointer-fine:not-any-pointer-coarse:py-1.5",
          typeof className === "function" ? className(state) : className
        )
      }
      {...props}
    >
      <ChevronUpIcon className="size-4" aria-hidden="true" />
    </SelectPrimitive.ScrollUpArrow>
  )
}

function SelectScrollDownButton({
  className,
  ...props
}: ComponentProps<typeof SelectPrimitive.ScrollDownArrow>) {
  return (
    <SelectPrimitive.ScrollDownArrow
      data-slot="select-scroll-down-button"
      className={(state) =>
        cn(
          "flex min-h-11 items-center justify-center bg-popover text-popover-foreground md:pointer-fine:not-any-pointer-coarse:min-h-9 md:pointer-fine:not-any-pointer-coarse:py-1.5",
          typeof className === "function" ? className(state) : className
        )
      }
      {...props}
    >
      <ChevronDownIcon className="size-4" aria-hidden="true" />
    </SelectPrimitive.ScrollDownArrow>
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
