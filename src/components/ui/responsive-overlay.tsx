"use client"

import * as React from "react"
import { Drawer } from "@base-ui/react/drawer"
import { cn } from "cn"

type Presentation = "dialog" | "sheet" | "panel" | "alert"
type MobileSide = "bottom" | "left" | "right"
type OverlayContextValue = {
  mobile: boolean
  desktop: Presentation
  mobileSide: MobileSide
  dismissible: boolean
}

const OverlayContext = React.createContext<OverlayContextValue | null>(null)

function useOverlay() {
  const context = React.useContext(OverlayContext)
  if (!context) throw new Error("Overlay parts must be inside an overlay root")
  return context
}

function Root({
  desktop = "dialog",
  mobileSide = "bottom",
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
  mobileSide?: MobileSide
  breakpoint?: "md" | "lg"
  dismissible?: boolean
}) {
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
  const docked = desktop === "panel" && !mobile
  return (
    <OverlayContext.Provider
      value={{ mobile, desktop, mobileSide, dismissible }}
    >
      <Drawer.Root
        {...props}
        modal={desktop === "alert" || (!docked && modal)}
        disablePointerDismissal={
          desktop === "alert" || docked || disablePointerDismissal
        }
        swipeDirection={mobileSide === "bottom" ? "down" : mobileSide}
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

function Backdrop({ className, ...props }: Drawer.Backdrop.Props) {
  const { mobile, desktop } = useOverlay()
  if (desktop === "panel" && !mobile) return null
  return (
    <Drawer.Backdrop
      {...props}
      data-overlay-mobile={mobile}
      className={cn(className, "responsive-overlay-backdrop")}
    />
  )
}

function Popup({
  children,
  className,
  mobileLayout = "content",
  ...props
}: Drawer.Popup.Props & { mobileLayout?: "content" | "panel" }) {
  const { mobile, desktop, mobileSide, dismissible } = useOverlay()
  return (
    <Drawer.Viewport
      className="responsive-overlay-viewport"
      data-overlay-mobile={mobile}
      data-mobile-side={mobileSide}
      data-desktop={desktop}
    >
      <Drawer.Popup
        {...props}
        role={desktop === "alert" ? "alertdialog" : (props.role ?? "dialog")}
        initialFocus={props.initialFocus ?? (mobile ? undefined : true)}
        data-overlay-mobile={mobile}
        data-mobile-side={mobileSide}
        data-mobile-layout={mobileLayout}
        data-desktop={desktop}
        data-base-ui-swipe-ignore={!mobile || !dismissible ? "" : undefined}
        className={cn(className, "responsive-overlay")}
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

// A single primitive tree keeps local form and terminal state across breakpoints.
// Dialog/Sheet/AlertDialog add the shadcn presentation and use this shared lifecycle.
export const ResponsiveOverlay = {
  Root,
  Popup,
  Backdrop,
  Portal: Drawer.Portal,
  Trigger: Drawer.Trigger,
  Close: Drawer.Close,
  Title: Drawer.Title,
  Description: Drawer.Description,
}
