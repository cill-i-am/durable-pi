"use client"

import { Drawer } from "@base-ui/react/drawer"
import { cn } from "@workspace/ui/lib/utils"
import * as React from "react"

type Presentation = "dialog" | "sheet" | "alert"
type OverlayContextValue = {
  mobile: boolean
  desktop: Presentation
  layer: number
  dismissible: boolean
}

const OverlayContext = React.createContext<OverlayContextValue | null>(null)

function useOverlay() {
  const context = React.useContext(OverlayContext)
  if (!context) throw new Error("Overlay parts must be inside an overlay root")
  return context
}

export function useOverlayMobile() {
  return useOverlay().mobile
}

export function overlayClassName<State>(
  base: string,
  value: string | ((state: State) => string | undefined) | undefined
) {
  return (state: State) =>
    cn(base, typeof value === "function" ? value(state) : value)
}

function Root({
  desktop = "dialog",
  breakpoint = "md",
  dismissible = true,
  modal = true,
  disablePointerDismissal,
  onOpenChange,
  children,
  ...props
}: Omit<Drawer.Root.Props, "children"> & {
  children?: React.ReactNode
  desktop?: Presentation
  breakpoint?: "md" | "lg"
  dismissible?: boolean
}) {
  const parent = React.useContext(OverlayContext)
  const layer = (parent?.layer ?? -1) + 1
  const query = `(max-width: ${breakpoint === "lg" ? 1023 : 767}px)`
  const subscribe = React.useCallback(
    (notify: () => void) => {
      const media = window.matchMedia(query)
      media.addEventListener("change", notify)
      return () => media.removeEventListener("change", notify)
    },
    [query]
  )
  const mobile = React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false
  )
  return (
    <OverlayContext.Provider value={{ mobile, desktop, layer, dismissible }}>
      <Drawer.Root
        {...props}
        modal={desktop === "alert" || modal}
        disablePointerDismissal={desktop === "alert" || disablePointerDismissal}
        swipeDirection="down"
        onOpenChange={(open, details) => {
          if (
            !open &&
            (!dismissible || (!mobile && details.reason === "swipe"))
          ) {
            details.cancel()
            return
          }
          onOpenChange?.(open, details)
        }}
      >
        <Drawer.VirtualKeyboardProvider>
          {children}
        </Drawer.VirtualKeyboardProvider>
      </Drawer.Root>
    </OverlayContext.Provider>
  )
}

function Backdrop({ className, style, ...props }: Drawer.Backdrop.Props) {
  const { mobile, desktop, layer } = useOverlay()
  return (
    <Drawer.Backdrop
      forceRender
      {...props}
      data-overlay-mobile={mobile}
      data-desktop={desktop}
      style={(state) => ({
        ...(typeof style === "function" ? style(state) : style),
        zIndex: 50 + layer * 2,
      })}
      className={overlayClassName("responsive-overlay-backdrop", className)}
    />
  )
}

function Popup({
  children,
  className,
  mobileLayout = "content",
  ...props
}: Drawer.Popup.Props & { mobileLayout?: "content" | "panel" }) {
  const { mobile, desktop, layer, dismissible } = useOverlay()
  return (
    <Drawer.Viewport
      className="responsive-overlay-viewport"
      style={{ zIndex: 51 + layer * 2 }}
      data-overlay-mobile={mobile}
      data-desktop={desktop}
    >
      <Drawer.Popup
        {...props}
        role={desktop === "alert" ? "alertdialog" : (props.role ?? "dialog")}
        initialFocus={props.initialFocus ?? (mobile ? undefined : true)}
        data-overlay-mobile={mobile}
        data-mobile-layout={mobileLayout}
        data-desktop={desktop}
        data-base-ui-swipe-ignore={!mobile || !dismissible ? "" : undefined}
        className={overlayClassName("responsive-overlay", className)}
      >
        <div className="responsive-overlay-handle" aria-hidden="true">
          <span />
        </div>
        <Drawer.Content className="responsive-overlay-body">
          {children}
        </Drawer.Content>
      </Drawer.Popup>
    </Drawer.Viewport>
  )
}

function Close({ disabled, ...props }: Drawer.Close.Props) {
  const { dismissible } = useOverlay()
  return <Drawer.Close {...props} disabled={disabled || !dismissible} />
}

// Drawer owns presence, nested focus, gestures and transition completion. Only
// presentation changes at the breakpoint; the mounted content tree stays put.
export const ResponsiveOverlay = {
  Root,
  Popup,
  Backdrop,
  Portal: Drawer.Portal,
  Trigger: Drawer.Trigger,
  Close,
  Title: Drawer.Title,
  Description: Drawer.Description,
}
