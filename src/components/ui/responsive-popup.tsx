import { useRender } from "@base-ui/react/use-render"
import * as React from "react"

import { ResponsiveOverlay } from "@/components/ui/responsive-overlay"
import { useIsMobile } from "@/hooks/use-mobile"

const PopupContext = React.createContext<{
  mobile: boolean
  trigger: React.RefObject<HTMLElement | null>
  afterClose: React.RefObject<(() => void) | null>
  onTabOut?: () => void
} | null>(null)

function Root({
  open,
  onOpenChange,
  children,
  onTabOut,
}: Pick<
  React.ComponentProps<typeof ResponsiveOverlay.Root>,
  "open" | "onOpenChange" | "children"
> & { onTabOut?: () => void }) {
  const mobile = useIsMobile()
  const trigger = React.useRef<HTMLElement>(null)
  const parent = React.useContext(PopupContext)
  const localAction = React.useRef<(() => void) | null>(null)
  const afterClose = parent?.afterClose ?? localAction
  return (
    <PopupContext.Provider value={{ mobile, trigger, afterClose, onTabOut }}>
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
  finalFocus,
}: {
  title: string
  children: React.ReactNode
  finalFocus?: React.ComponentProps<
    typeof ResponsiveOverlay.Popup
  >["finalFocus"]
}) {
  const context = React.useContext(PopupContext)
  const popup = React.useRef<HTMLDivElement>(null)
  return (
    <ResponsiveOverlay.Portal>
      <ResponsiveOverlay.Backdrop />
      <ResponsiveOverlay.Popup
        className="responsive-popup-shell"
        ref={popup}
        initialFocus={() =>
          popup.current?.querySelector<HTMLElement>(
            '[role="option"][tabindex="0"]'
          ) ??
          popup.current?.querySelector<HTMLElement>(
            '[role="option"]:not([aria-disabled="true"])'
          ) ??
          popup.current?.querySelector<HTMLElement>(
            '[role="menu"], [role="listbox"]'
          ) ??
          popup.current
        }
        finalFocus={
          finalFocus ??
          (() =>
            context?.afterClose.current ? false : context?.trigger.current)
        }
        onKeyDown={(event) => {
          if (
            event.key !== "Tab" ||
            event.defaultPrevented ||
            !context?.onTabOut
          )
            return
          event.preventDefault()
          context.onTabOut()
        }}
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

export function usePopupClose() {
  return React.useContext(PopupContext)?.onTabOut
}
