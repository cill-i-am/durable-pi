"use client"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import * as React from "react"

import {
  overlayClassName,
  ResponsiveOverlay as Primitive,
} from "./responsive-overlay"

function AlertDialog(props: React.ComponentProps<typeof Primitive.Root>) {
  return <Primitive.Root desktop="alert" {...props} />
}

const AlertDialogTrigger = Primitive.Trigger
const AlertDialogPortal = Primitive.Portal

function AlertDialogOverlay(
  props: React.ComponentProps<typeof Primitive.Backdrop>
) {
  return <Primitive.Backdrop data-slot="alert-dialog-overlay" {...props} />
}

function AlertDialogContent({
  className,
  size = "default",
  keepMounted = false,
  ...props
}: React.ComponentProps<typeof Primitive.Popup> & {
  size?: "default" | "sm"
  keepMounted?: boolean
}) {
  return (
    <AlertDialogPortal keepMounted={keepMounted}>
      <AlertDialogOverlay />
      <Primitive.Popup
        {...props}
        data-slot="alert-dialog-content"
        data-size={size}
        className={overlayClassName("ui-alert-dialog", className)}
      />
    </AlertDialogPortal>
  )
}

function AlertDialogHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn("dialog-header", className)}
      {...props}
    />
  )
}

function AlertDialogFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn("dialog-footer", className)}
      {...props}
    />
  )
}

function AlertDialogMedia({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-media"
      className={cn("alert-dialog-media", className)}
      {...props}
    />
  )
}

function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.Title>) {
  return (
    <Primitive.Title
      data-slot="alert-dialog-title"
      className={overlayClassName("overlay-title", className)}
      {...props}
    />
  )
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.Description>) {
  return (
    <Primitive.Description
      data-slot="alert-dialog-description"
      className={overlayClassName("overlay-description", className)}
      {...props}
    />
  )
}

function AlertDialogAction(props: React.ComponentProps<typeof Button>) {
  return <Button data-slot="alert-dialog-action" {...props} />
}

function AlertDialogCancel({
  variant = "outline",
  size = "default",
  ...props
}: React.ComponentProps<typeof Primitive.Close> &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <Primitive.Close
      data-slot="alert-dialog-cancel"
      render={<Button variant={variant} size={size} />}
      {...props}
    />
  )
}

export {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
}
