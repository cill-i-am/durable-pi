"use client"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import { ArrowLeftIcon, XIcon } from "lucide-react"
import * as React from "react"

import {
  overlayClassName,
  ResponsiveOverlay as Primitive,
} from "./responsive-overlay"

function Sheet(props: React.ComponentProps<typeof Primitive.Root>) {
  return <Primitive.Root desktop="sheet" {...props} />
}

const SheetTrigger = Primitive.Trigger
const SheetClose = Primitive.Close
const SheetPortal = Primitive.Portal

function SheetOverlay(props: React.ComponentProps<typeof Primitive.Backdrop>) {
  return <Primitive.Backdrop data-slot="sheet-overlay" {...props} />
}

function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  showOverlay = true,
  keepMounted = false,
  portalContainer,
  ...props
}: React.ComponentProps<typeof Primitive.Popup> & {
  side?: "top" | "right" | "bottom" | "left"
  showCloseButton?: boolean
  showOverlay?: boolean
  keepMounted?: boolean
  portalContainer?: React.ComponentProps<typeof Primitive.Portal>["container"]
}) {
  return (
    <SheetPortal container={portalContainer} keepMounted={keepMounted}>
      {showOverlay && <SheetOverlay />}
      <Primitive.Popup
        {...props}
        data-slot="sheet-content"
        data-side={side}
        className={overlayClassName("ui-sheet", className)}
      >
        {children}
        {showCloseButton && (
          <SheetClose
            render={
              <Button variant="ghost" size="icon" className="overlay-close" />
            }
            aria-label="Close sheet"
          >
            <XIcon aria-hidden="true" />
          </SheetClose>
        )}
      </Primitive.Popup>
    </SheetPortal>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("sheet-header", className)}
      {...props}
    />
  )
}

function SheetBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-body"
      className={cn("sheet-body", className)}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("sheet-footer", className)}
      {...props}
    />
  )
}

function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.Title>) {
  return (
    <Primitive.Title
      data-slot="sheet-title"
      className={overlayClassName("overlay-title", className)}
      {...props}
    />
  )
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.Description>) {
  return (
    <Primitive.Description
      data-slot="sheet-description"
      className={overlayClassName("overlay-description", className)}
      {...props}
    />
  )
}

function SheetNavigation({
  title,
  backLabel,
  onBack,
  closeLabel = "Close sheet",
  showCloseButton = true,
}: {
  title: React.ReactNode
  backLabel?: string
  onBack?: () => void
  closeLabel?: string
  showCloseButton?: boolean
}) {
  const back = (
    <>
      <ArrowLeftIcon aria-hidden="true" />
      <span>{backLabel}</span>
    </>
  )
  return (
    <header className="sheet-navigation" data-has-back={!!backLabel}>
      <div className="sheet-navigation-leading">
        {backLabel &&
          (onBack ? (
            <Button variant="ghost" onClick={onBack} className="sheet-back">
              {back}
            </Button>
          ) : (
            <SheetClose
              render={<Button variant="ghost" className="sheet-back" />}
            >
              {back}
            </SheetClose>
          ))}
      </div>
      <SheetTitle className="sheet-navigation-title">{title}</SheetTitle>
      <div className="sheet-navigation-trailing">
        {showCloseButton && (
          <SheetClose
            render={<Button variant="ghost" size="icon" />}
            aria-label={closeLabel}
          >
            <XIcon aria-hidden="true" />
          </SheetClose>
        )}
      </div>
    </header>
  )
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetPortal,
  SheetOverlay,
  SheetContent,
  SheetHeader,
  SheetBody,
  SheetFooter,
  SheetTitle,
  SheetDescription,
  SheetNavigation,
}
