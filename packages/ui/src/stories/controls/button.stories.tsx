import type { Meta, StoryObj } from "@storybook/react-vite"
import { Button } from "@workspace/ui/components/button"
import { MoreHorizontalIcon } from "lucide-react"
import { expect, userEvent, within } from "storybook/test"

import {
  ActionDemo,
  ButtonStateMatrix,
  ButtonSizeMatrix,
  buttonStateParameters,
} from "./fixtures"

const meta = {
  title: "Components/Button",
  component: Button,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    children: "Save",
    variant: "default",
    size: "default",
    disabled: false,
    static: false,
  },
  argTypes: {
    variant: {
      control: "select",
      options: [
        "default",
        "outline",
        "secondary",
        "destructive",
        "ghost",
        "link",
      ],
    },
    size: {
      control: "select",
      options: ["sm", "default", "lg", "icon-sm", "icon", "icon-lg"],
    },
    children: { control: "text" },
    disabled: { control: "boolean" },
    static: { control: "boolean" },
  },
} satisfies Meta<typeof Button>
export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: (args) => (
    <Button
      {...args}
      aria-label={args.size?.startsWith("icon") ? "More options" : undefined}
    >
      {args.size?.startsWith("icon") ? <MoreHorizontalIcon /> : args.children}
    </Button>
  ),
}
export const Static: Story = { args: { static: true } }
export const Motion: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Button>Press</Button>
      <Button static>Static</Button>
      <Button disabled>Disabled</Button>
    </div>
  ),
}
export const States: Story = {
  parameters: buttonStateParameters,
  render: () => <ButtonStateMatrix />,
}
export const Sizes: Story = {
  parameters: { controls: { disable: true } },
  render: () => <ButtonSizeMatrix />,
}

export const SaveSuccess: Story = {
  parameters: { controls: { disable: true } },
  render: () => <ActionDemo scenario="success" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Save default" }))
    await expect(canvas.getByRole("button", { name: "Saving…" })).toBeDisabled()
    await expect(await canvas.findByRole("status")).toHaveTextContent(
      "Default saved."
    )
  },
}

export const SaveError: Story = {
  parameters: { controls: { disable: true } },
  render: () => <ActionDemo scenario="error" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Save default" }))
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "Couldn’t save."
    )
  },
}

export const SaveUnconfirmed: Story = {
  parameters: { controls: { disable: true } },
  render: () => <ActionDemo scenario="uncertain" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Save default" }))
    await expect(await canvas.findByRole("status")).toHaveTextContent(
      "Save not confirmed."
    )
    await expect(
      canvas.getByRole("button", { name: "Check status" })
    ).toBeEnabled()
    await expect(
      canvas.queryByRole("button", { name: "Save default" })
    ).not.toBeInTheDocument()
  },
}

export const SaveCancellation: Story = {
  parameters: { controls: { disable: true } },
  render: () => <ActionDemo scenario="hold" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Save default" }))
    await userEvent.click(canvas.getByRole("button", { name: "Cancel" }))
    await expect(await canvas.findByRole("status")).toHaveTextContent(
      "Save cancelled."
    )
  },
}
