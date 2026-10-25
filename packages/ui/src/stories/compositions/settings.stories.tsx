import type { Meta, StoryObj } from "@storybook/react-vite"

import {
  DrawerStack,
  DialogExample,
  DesktopSheetExample,
  ConfirmationExample,
} from "../overlays/overlay-fixtures"

const meta = {
  title: "Compositions/Settings",
  component: DrawerStack,
  parameters: { layout: "fullscreen" },
  args: {
    startAt: "closed",
    scenario: "success",
    longContent: false,
    title: "Model access",
    backLabel: "Family",
  },
  argTypes: {
    startAt: {
      control: "select",
      options: ["closed", "root", "child", "third"],
    },
    scenario: {
      control: "select",
      options: ["success", "error", "uncertain", "hold"],
    },
    longContent: { control: "boolean" },
    title: { control: "text" },
    backLabel: { control: "text" },
  },
} satisfies Meta<typeof DrawerStack>

export default meta
type Story = StoryObj<typeof meta>

export const StackedSettings: Story = {}
export const Root: Story = { args: { startAt: "root" } }
export const Child: Story = { args: { startAt: "child" } }
export const ThirdLayer: Story = { args: { startAt: "third" } }
export const GuardedPending: Story = {
  args: { startAt: "third", scenario: "hold" },
}
export const RetryFailure: Story = {
  args: { startAt: "third", scenario: "error" },
}
export const UnconfirmedSave: Story = {
  args: { startAt: "third", scenario: "uncertain" },
}
export const LongContent: Story = {
  args: { startAt: "third", longContent: true },
}
export const LongLabels: Story = {
  args: {
    startAt: "third",
    title: "Model access for the whole family",
    backLabel: "Family settings",
  },
}

export const DesktopDialog: Story = {
  render: ({ scenario }) => <DialogExample scenario={scenario} />,
}

export const DesktopSheet: Story = {
  render: ({ scenario }) => <DesktopSheetExample scenario={scenario} />,
}

export const DestructiveConfirmation: Story = {
  render: ({ scenario }) => <ConfirmationExample scenario={scenario} />,
}
