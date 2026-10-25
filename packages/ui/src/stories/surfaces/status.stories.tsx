import type { Meta, StoryObj } from "@storybook/react-vite"
import { Status } from "@workspace/ui/components/badge"
import { AlertCircleIcon, CheckIcon } from "lucide-react"

const meta = {
  title: "Components/Status",
  component: Status,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  args: { tone: "default", children: "Connected" },
  argTypes: {
    tone: { control: "select", options: ["default", "warning", "destructive"] },
    children: { control: "text" },
    role: { control: "text" },
  },
} satisfies Meta<typeof Status>
export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const Playground: Story = {
  args: { tone: "warning", children: "Waiting for confirmation" },
}
export const WithIcon: Story = {
  args: {
    children: (
      <>
        <CheckIcon aria-hidden="true" />
        Connected
      </>
    ),
  },
  argTypes: { children: { control: false } },
}
export const Warning: Story = {
  args: { tone: "warning", children: "Unconfirmed" },
}
export const Error: Story = {
  args: {
    tone: "destructive",
    children: (
      <>
        <AlertCircleIcon aria-hidden="true" />
        Couldn’t connect
      </>
    ),
  },
  argTypes: { children: { control: false } },
}
export const LiveAnnouncement: Story = {
  args: { role: "status", children: "Changes saved." },
}
