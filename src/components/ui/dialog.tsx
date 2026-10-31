"use client"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import { XIcon } from "lucide-react"
import * as React from "react"

import {
  overlayClassName,
  ResponsiveOverlay as Primitive,
} from "./responsive-overlay"

function Dialog(props: React.ComponentProps<typeof Primitive.Root>) {
  return <Primitive.Root desktop="dialog" {...props} />
}

const DialogTrigger = Primitive.Trigger
const DialogClose = Primitive.Close
const DialogPortal = Primitive.Portal

function DialogOverlay(props: React.ComponentProps<typeof Primitive.Backdrop>) {
  return <Primitive.Backdrop data-slot="dialog-overlay" {...props} />
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  keepMounted = false,
  overlayClassName: backdropClassName,
  container,
  ...props
}: React.ComponentProps<typeof Primitive.Popup> & {
  showCloseButton?: boolean
  keepMounted?: boolean
  overlayClassName?: string
  container?: React.ComponentProps<typeof Primitive.Portal>["container"]
}) {
  return (
    <DialogPortal keepMounted={keepMounted} container={container}>
      <DialogOverlay className={backdropClassName} />
      <Primitive.Popup
        {...props}
        data-slot="dialog-content"
        className={overlayClassName("ui-dialog", className)}
      >
        {children}
        {showCloseButton && (
          <DialogClose
            render={
              <Button variant="ghost" size="icon" className="overlay-close" />
            }
            aria-label="Close dialog"
          >
            <XIcon aria-hidden="true" />
          </DialogClose>
        )}
      </Primitive.Popup>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("dialog-header", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & { showCloseButton?: boolean }) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("dialog-footer", className)}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.Title>) {
  return (
    <Primitive.Title
      data-slot="dialog-title"
      className={overlayClassName("overlay-title", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.Description>) {
  return (
    <Primitive.Description
      data-slot="dialog-description"
      className={overlayClassName("overlay-description", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
