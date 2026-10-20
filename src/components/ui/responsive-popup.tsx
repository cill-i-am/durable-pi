import { useRender } from "@base-ui/react/use-render"
import * as React from "react"

import { ResponsiveOverlay } from "@/components/ui/responsive-overlay"
import { useIsMobile } from "@/hooks/use-mobile"

const PopupContext = React.createContext<{
  mobile: boolean
  trigger: React.RefObject<HTMLElement | null>
  afterClose: React.RefObject<(() => void) | null>
} | null>(null)

function Root({
  open,
  onOpenChange,
  children,
}: Pick<
  React.ComponentProps<typeof ResponsiveOverlay.Root>,
  "open" | "onOpenChange" | "children"
>) {
  const mobile = useIsMobile()
  const trigger = React.useRef<HTMLElement>(null)
  const parent = React.useContext(PopupContext)
  const localAction = React.useRef<(() => void) | null>(null)
  const afterClose = parent?.afterClose ?? localAction
  return (
    <PopupContext.Provider value={{ mobile, trigger, afterClose }}>
      <ResponsiveOverlay.Root
        open={mobile && open}
        onOpenChange={onOpenChange}
        onOpenChangeComplete={(next) => {
          if (next) return
          const action = afterClose.current
          afterClose.current = null
          action?.()
        }}
      >
        {children}
      </ResponsiveOverlay.Root>
    </PopupContext.Provider>
  )
}

function Trigger({ children }: { children: React.ReactElement }) {
  const context = React.useContext(PopupContext)
  return useRender({ render: children, ref: context?.trigger })
}

function Content({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  const context = React.useContext(PopupContext)
  const popup = React.useRef<HTMLDivElement>(null)
  return (
    <ResponsiveOverlay.Portal>
      <ResponsiveOverlay.Backdrop className="fixed inset-0 bg-black/30" />
      <ResponsiveOverlay.Popup
        className="bg-popover text-popover-foreground shadow-(--shadow-drawer)"
        ref={popup}
        initialFocus={() =>
          popup.current?.querySelector<HTMLElement>(
            '[role="menu"], [role="listbox"]'
          ) ?? popup.current
        }
        finalFocus={() =>
          context?.afterClose.current ? false : context?.trigger.current
        }
      >
        <ResponsiveOverlay.Title className="sr-only">
          {title}
        </ResponsiveOverlay.Title>
        <div className="responsive-popup">{children}</div>
      </ResponsiveOverlay.Popup>
    </ResponsiveOverlay.Portal>
  )
}

export const ResponsivePopup = { Root, Content, Trigger }
export function usePopupMobile() {
  return React.useContext(PopupContext)?.mobile ?? false
}

export function usePopupAction() {
  const context = React.useContext(PopupContext)
  return (action: () => void) => {
    if (context?.mobile) context.afterClose.current = action
    else action()
  }
}
