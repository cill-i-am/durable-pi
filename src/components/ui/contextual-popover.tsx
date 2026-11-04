import { Popover as PopoverPrimitive } from "@base-ui/react/popover"
import { Button } from "@workspace/ui/components/button"
import { useUIReducedMotion } from "@workspace/ui/hooks/use-ui-reduced-motion"
import { cn } from "@workspace/ui/lib/utils"
import { XIcon } from "lucide-react"
import { useState, type ReactNode } from "react"

import { useIsMobile } from "@/hooks/use-mobile"

import { ResponsiveOverlay } from "./responsive-overlay"
import { ResponsivePopup, usePopupMobile } from "./responsive-popup"

import "./contextual-popover.css"

function ContextualPopover({
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  children,
}: {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  children: ReactNode
}) {
  const mobile = useIsMobile()
  const [localOpen, setLocalOpen] = useState(defaultOpen)
  const open = controlledOpen ?? localOpen
  const changeOpen = (next: boolean) => {
    onOpenChange?.(next)
    setLocalOpen(next)
  }
  return (
    <PopoverPrimitive.Root
      open={open}
      modal={false}
      onOpenChange={(next, details) => {
        // The native drawer owns mobile dismissal, including nested selects.
        if (mobile && ["outside-press", "focus-out"].includes(details.reason)) {
          details.cancel()
          return
        }
        changeOpen(next)
      }}
    >
      <ResponsivePopup.Root open={open} onOpenChange={changeOpen}>
        {children}
      </ResponsivePopup.Root>
    </PopoverPrimitive.Root>
  )
}

function ContextualPopoverTrigger(props: PopoverPrimitive.Trigger.Props) {
  return (
    <ResponsivePopup.Trigger>
      <PopoverPrimitive.Trigger
        data-slot="contextual-popover-trigger"
        {...props}
      />
    </ResponsivePopup.Trigger>
  )
}

function ContextualPopoverContent({
  title,
  children,
  className,
  align = "end",
}: {
  title: string
  children: ReactNode
  className?: string
  align?: PopoverPrimitive.Positioner.Props["align"]
}) {
  const mobile = usePopupMobile()
  const reduced = useUIReducedMotion()
  if (mobile) {
    return (
      <PopoverPrimitive.Portal keepMounted>
        <ResponsivePopup.Content
          title={title}
          className="contextual-popover-drawer"
          titleClassName="overlay-title contextual-popover-mobile-title"
          finalFocus={() => window.matchMedia("(max-width: 767px)").matches}
        >
          <PopoverPrimitive.Positioner className="responsive-popup-positioner">
            <PopoverPrimitive.Popup
              role="presentation"
              aria-labelledby={undefined}
              initialFocus={false}
              finalFocus={false}
              data-slot="contextual-popover-content"
              className={cn(
                "responsive-popup-content contextual-popover-content",
                className
              )}
            >
              <ResponsiveOverlay.Close
                render={
                  <Button variant="ghost" size="icon" aria-label="Close" />
                }
                className="overlay-close"
              >
                <XIcon aria-hidden="true" />
              </ResponsiveOverlay.Close>
              {children}
            </PopoverPrimitive.Popup>
          </PopoverPrimitive.Positioner>
        </ResponsivePopup.Content>
      </PopoverPrimitive.Portal>
    )
  }
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        side="bottom"
        sideOffset={8}
        className="isolate z-50 outline-none"
      >
        <PopoverPrimitive.Popup
          data-slot="contextual-popover-content"
          data-motion-reduced={reduced ? "true" : undefined}
          className={cn(
            "ui-floating-popup contextual-popover-content",
            className
          )}
        >
          <PopoverPrimitive.Title className="contextual-popover-title">
            {title}
          </PopoverPrimitive.Title>
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

export { ContextualPopover, ContextualPopoverTrigger, ContextualPopoverContent }
