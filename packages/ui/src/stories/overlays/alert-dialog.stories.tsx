import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@workspace/ui/components/alert-dialog"
import { Button } from "@workspace/ui/components/button"
import { ResponsiveOverlay } from "@workspace/ui/components/responsive-overlay"
import * as React from "react"

type Args = Omit<React.ComponentProps<typeof AlertDialog>, "children"> &
  Pick<React.ComponentProps<typeof AlertDialogContent>, "size" | "keepMounted">

function ConfirmationExample({ size, keepMounted, ...props }: Args) {
  return (
    <main className="drawer-lab">
      <AlertDialog {...props}>
        <AlertDialogTrigger render={<Button variant="outline" />}>
          Open alert dialog
        </AlertDialogTrigger>
        <AlertDialogContent size={size} keepMounted={keepMounted}>
          <AlertDialogHeader>
            <AlertDialogTitle>Continue with this change?</AlertDialogTitle>
            <AlertDialogDescription>
              Review the change before continuing.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <ResponsiveOverlay.Close render={<AlertDialogAction />}>
              Continue
            </ResponsiveOverlay.Close>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  )
}

const meta = {
  title: "Components/AlertDialog",
  component: AlertDialog,
  subcomponents: {
    AlertDialogTrigger,
    AlertDialogContent,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogDescription,
    AlertDialogMedia,
    AlertDialogFooter,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogOverlay,
    AlertDialogPortal,
  },
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: {
    defaultOpen: false,
    dismissible: true,
    breakpoint: "md",
    size: "default",
    keepMounted: false,
  },
  argTypes: {
    defaultOpen: { control: "boolean", table: { category: "Root" } },
    dismissible: { control: "boolean", table: { category: "Root" } },
    breakpoint: {
      control: "select",
      options: ["md", "lg"],
      table: { category: "Root" },
    },
    size: {
      control: "select",
      options: ["default", "sm"],
      table: { category: "Content" },
    },
    keepMounted: { control: "boolean", table: { category: "Content" } },
    open: { control: false },
    modal: { control: false },
  },
  render: (args) => <ConfirmationExample {...args} />,
} satisfies Meta<Args>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const Open: Story = { args: { defaultOpen: true } }
export const Small: Story = { args: { defaultOpen: true, size: "sm" } }
export const KeptMounted: Story = { args: { keepMounted: true } }
export const Guarded: Story = {
  args: { defaultOpen: true, dismissible: false },
}
