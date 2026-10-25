"use client"

import { Menu as MenuPrimitive } from "@base-ui/react/menu"
import { useIsMobile } from "@workspace/ui/hooks/use-mobile"
import { cn } from "@workspace/ui/lib/utils"
import { CheckIcon, ChevronRightIcon } from "lucide-react"
import * as React from "react"

import {
  ResponsivePopup,
  usePopupAction,
  usePopupMobile,
} from "./responsive-popup"

function useMenuPresentation({
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
}: Pick<MenuPrimitive.Root.Props, "open" | "defaultOpen" | "onOpenChange">) {
  const mobile = useIsMobile()
  const [localOpen, setLocalOpen] = React.useState(defaultOpen)
  const open = controlledOpen ?? localOpen
  const onMenuChange: NonNullable<MenuPrimitive.Root.Props["onOpenChange"]> = (
    next,
    details
  ) => {
    if (
      mobile &&
      ["focus-out", "outside-press", "cancel-open"].includes(details.reason)
    ) {
      details.cancel()
      return
    }
    onOpenChange?.(next, details)
    if (!details.isCanceled) setLocalOpen(next)
  }
  const onDrawerChange: NonNullable<
    React.ComponentProps<typeof ResponsivePopup.Root>["onOpenChange"]
  > = (next, details) => {
    onOpenChange?.(next, { ...details, reason: "none" })
    if (!details.isCanceled) setLocalOpen(next)
  }
  return { mobile, open, onMenuChange, onDrawerChange }
}

function DropdownMenu({
  children,
  withinMenubar = false,
  ...props
}: Omit<MenuPrimitive.Root.Props, "children"> & {
  children?: React.ReactNode
  withinMenubar?: boolean
}) {
  const { mobile, open, onMenuChange, onDrawerChange } =
    useMenuPresentation(props)
  const localActions = React.useRef<MenuPrimitive.Root.Actions>(null)
  const actions = props.actionsRef ?? localActions
  return (
    <MenuPrimitive.Root
      {...props}
      actionsRef={actions}
      open={open}
      modal={mobile && !withinMenubar ? false : props.modal}
      onOpenChange={onMenuChange}
    >
      <ResponsivePopup.Root
        open={open}
        onOpenChange={onDrawerChange}
        onTabOut={() => actions.current?.close()}
      >
        {children}
      </ResponsivePopup.Root>
    </MenuPrimitive.Root>
  )
}

function DropdownMenuPortal(props: MenuPrimitive.Portal.Props) {
  return <MenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />
}

function DropdownMenuTrigger(props: MenuPrimitive.Trigger.Props) {
  return (
    <ResponsivePopup.Trigger>
      <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
    </ResponsivePopup.Trigger>
  )
}

function DropdownMenuContent({
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  className,
  mobileTitle = "Actions",
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<
    MenuPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  > & { mobileTitle?: string }) {
  const mobile = usePopupMobile()
  if (mobile) {
    return (
      <MenuPrimitive.Portal keepMounted>
        <ResponsivePopup.Content
          title={mobileTitle}
          finalFocus={props.finalFocus}
        >
          <MenuPrimitive.Positioner className="responsive-popup-positioner">
            <MenuPrimitive.Popup
              {...props}
              finalFocus={false}
              data-slot="dropdown-menu-content"
              className={cn("responsive-popup-content", className)}
            />
          </MenuPrimitive.Positioner>
        </ResponsivePopup.Content>
      </MenuPrimitive.Portal>
    )
  }
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        className="isolate z-50 outline-none"
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            "max-h-(--available-height) w-max max-w-[min(24rem,calc(100vw-2rem))] min-w-[248px] origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-[10px] border border-border bg-popover p-1 text-popover-foreground shadow-(--shadow-menu) transition-[opacity,transform] duration-100 outline-none data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none",
            className
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

function DropdownMenuGroup({ className, ...props }: MenuPrimitive.Group.Props) {
  return (
    <MenuPrimitive.Group
      data-slot="dropdown-menu-group"
      className={cn("flex flex-col", className)}
      {...props}
    />
  )
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: MenuPrimitive.GroupLabel.Props & { inset?: boolean }) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        "px-3 py-2 text-sm/[1.25rem] text-muted-foreground data-inset:pl-9",
        className
      )}
      {...props}
    />
  )
}

const menuItemClassName =
  "relative flex min-h-11 cursor-default items-center gap-2 rounded-[6px] px-3 py-2 text-base/[1.25rem] outline-none select-none data-highlighted:bg-muted focus:bg-muted focus-visible:[box-shadow:inset_0_0_0_2px_var(--ring)] data-inset:pl-9 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-[18px] [&_svg]:shrink-0"

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  onClick,
  closeOnClick = true,
  ...props
}: MenuPrimitive.Item.Props & {
  inset?: boolean
  variant?: "default" | "destructive"
}) {
  const afterClose = usePopupAction()
  return (
    <MenuPrimitive.Item
      closeOnClick={closeOnClick}
      onClick={(event) => {
        if (!onClick) return
        if (closeOnClick) afterClose(() => onClick(event))
        else onClick(event)
      }}
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        menuItemClassName,
        "data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:data-highlighted:bg-destructive/10",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuSub({
  children,
  ...props
}: MenuPrimitive.SubmenuRoot.Props) {
  const { open, onMenuChange, onDrawerChange } = useMenuPresentation(props)
  const localActions = React.useRef<MenuPrimitive.Root.Actions>(null)
  const actions = props.actionsRef ?? localActions
  return (
    <MenuPrimitive.SubmenuRoot
      {...props}
      actionsRef={actions}
      open={open}
      onOpenChange={onMenuChange}
    >
      <ResponsivePopup.Root
        open={open}
        onOpenChange={onDrawerChange}
        onTabOut={() => actions.current?.close()}
      >
        {children}
      </ResponsivePopup.Root>
    </MenuPrimitive.SubmenuRoot>
  )
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props & { inset?: boolean }) {
  const mobile = usePopupMobile()
  return (
    <ResponsivePopup.Trigger>
      <MenuPrimitive.SubmenuTrigger
        openOnHover={!mobile}
        data-slot="dropdown-menu-sub-trigger"
        data-inset={inset}
        className={cn(menuItemClassName, "data-popup-open:bg-muted", className)}
        {...props}
      >
        {children}
        <ChevronRightIcon aria-hidden="true" className="ml-auto" />
      </MenuPrimitive.SubmenuTrigger>
    </ResponsivePopup.Trigger>
  )
}

function DropdownMenuSubContent({
  align = "start",
  alignOffset = -4,
  side = "right",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof DropdownMenuContent>) {
  return (
    <DropdownMenuContent
      data-slot="dropdown-menu-sub-content"
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      {...props}
    />
  )
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  ...props
}: MenuPrimitive.CheckboxItem.Props & { inset?: boolean }) {
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      data-inset={inset}
      className={cn(menuItemClassName, "pr-10", className)}
      checked={checked}
      {...props}
    >
      {children}
      <span
        data-slot="dropdown-menu-checkbox-item-indicator"
        className="pointer-events-none absolute right-3 flex size-5 items-center justify-center"
      >
        <MenuPrimitive.CheckboxItemIndicator>
          <CheckIcon aria-hidden="true" />
        </MenuPrimitive.CheckboxItemIndicator>
      </span>
    </MenuPrimitive.CheckboxItem>
  )
}

function DropdownMenuRadioGroup(props: MenuPrimitive.RadioGroup.Props) {
  return (
    <MenuPrimitive.RadioGroup
      data-slot="dropdown-menu-radio-group"
      {...props}
    />
  )
}

function DropdownMenuRadioItem({
  className,
  children,
  inset,
  ...props
}: MenuPrimitive.RadioItem.Props & { inset?: boolean }) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      data-inset={inset}
      className={cn(menuItemClassName, "pr-10", className)}
      {...props}
    >
      {children}
      <span
        data-slot="dropdown-menu-radio-item-indicator"
        className="pointer-events-none absolute right-3 flex size-5 items-center justify-center"
      >
        <MenuPrimitive.RadioItemIndicator>
          <CheckIcon aria-hidden="true" />
        </MenuPrimitive.RadioItemIndicator>
      </span>
    </MenuPrimitive.RadioItem>
  )
}

function DropdownMenuSeparator({
  className,
  ...props
}: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

function DropdownMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        "ml-auto pl-4 text-sm/[1.25rem] text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
}
