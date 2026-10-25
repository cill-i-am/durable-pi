import type { Meta, StoryObj } from "@storybook/react-vite"
import { Button } from "@workspace/ui/components/button"
import { Field, FieldGroup, FieldLabel } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetNavigation,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
} from "@workspace/ui/components/sheet"
import * as React from "react"

type Args = Omit<React.ComponentProps<typeof Sheet>, "children"> &
  Pick<
    React.ComponentProps<typeof SheetContent>,
    "side" | "showCloseButton" | "keepMounted"
  >

function SheetExample({ side, showCloseButton, keepMounted, ...props }: Args) {
  const name = React.useId()
  return (
    <main className="drawer-lab">
      <Sheet {...props}>
        <SheetTrigger render={<Button />}>Open sheet</SheetTrigger>
        <SheetContent
          side={side}
          showCloseButton={showCloseButton}
          keepMounted={keepMounted}
        >
          <SheetHeader>
            <SheetTitle>Edit profile</SheetTitle>
            <SheetDescription>
              Update the name shown beside your messages.
            </SheetDescription>
          </SheetHeader>
          <SheetBody>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={name}>Name</FieldLabel>
                <Input id={name} defaultValue="Cillian" />
              </Field>
            </FieldGroup>
          </SheetBody>
          <SheetFooter>
            <SheetClose render={<Button variant="outline" />}>
              Close sheet
            </SheetClose>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </main>
  )
}

const meta = {
  title: "Components/Sheet",
  component: Sheet,
  subcomponents: {
    SheetTrigger,
    SheetContent,
    SheetHeader,
    SheetNavigation,
    SheetTitle,
    SheetDescription,
    SheetBody,
    SheetFooter,
    SheetClose,
    SheetOverlay,
    SheetPortal,
  },
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: {
    defaultOpen: false,
    dismissible: true,
    modal: true,
    breakpoint: "md",
    side: "right",
    showCloseButton: true,
    keepMounted: false,
  },
  argTypes: {
    defaultOpen: { control: "boolean", table: { category: "Root" } },
    dismissible: { control: "boolean", table: { category: "Root" } },
    modal: { control: "boolean", table: { category: "Root" } },
    breakpoint: {
      control: "select",
      options: ["md", "lg"],
      table: { category: "Root" },
    },
    side: {
      control: "select",
      options: ["top", "right", "bottom", "left"],
      table: { category: "Content" },
    },
    showCloseButton: { control: "boolean", table: { category: "Content" } },
    keepMounted: { control: "boolean", table: { category: "Content" } },
    open: { control: false },
  },
  render: (args) => <SheetExample {...args} />,
} satisfies Meta<Args>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const Open: Story = { args: { defaultOpen: true } }
export const Left: Story = { args: { defaultOpen: true, side: "left" } }
export const Top: Story = { args: { defaultOpen: true, side: "top" } }
export const Bottom: Story = { args: { defaultOpen: true, side: "bottom" } }
export const NonModal: Story = { args: { defaultOpen: true, modal: false } }
export const WithoutCloseButton: Story = {
  args: { defaultOpen: true, showCloseButton: false },
}
export const KeptMounted: Story = { args: { keepMounted: true } }
export const Guarded: Story = {
  args: { defaultOpen: true, dismissible: false },
}
