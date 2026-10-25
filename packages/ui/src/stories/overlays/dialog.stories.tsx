import type { Meta, StoryObj } from "@storybook/react-vite"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from "@workspace/ui/components/dialog"
import { Field, FieldGroup, FieldLabel } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import * as React from "react"

type Args = Omit<React.ComponentProps<typeof Dialog>, "children"> &
  Pick<
    React.ComponentProps<typeof DialogContent>,
    "showCloseButton" | "keepMounted"
  >

function DialogExample({ showCloseButton, keepMounted, ...props }: Args) {
  const name = React.useId()
  return (
    <main className="drawer-lab">
      <Dialog {...props}>
        <DialogTrigger render={<Button />}>Open dialog</DialogTrigger>
        <DialogContent
          showCloseButton={showCloseButton}
          keepMounted={keepMounted}
        >
          <DialogHeader>
            <DialogTitle>Edit profile</DialogTitle>
            <DialogDescription>
              Update the name shown beside your messages.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={name}>Name</FieldLabel>
              <Input id={name} defaultValue="Cillian" />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Close dialog
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}

const meta = {
  title: "Components/Dialog",
  component: Dialog,
  subcomponents: {
    DialogTrigger,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
    DialogClose,
    DialogOverlay,
    DialogPortal,
  },
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: {
    defaultOpen: false,
    dismissible: true,
    modal: true,
    breakpoint: "md",
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
    showCloseButton: { control: "boolean", table: { category: "Content" } },
    keepMounted: { control: "boolean", table: { category: "Content" } },
    open: { control: false },
  },
  render: (args) => <DialogExample {...args} />,
} satisfies Meta<Args>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const Open: Story = { args: { defaultOpen: true } }
export const NonModal: Story = { args: { defaultOpen: true, modal: false } }
export const WithoutCloseButton: Story = {
  args: { defaultOpen: true, showCloseButton: false },
}
export const KeptMounted: Story = { args: { keepMounted: true } }
export const Guarded: Story = {
  args: { defaultOpen: true, dismissible: false },
}
