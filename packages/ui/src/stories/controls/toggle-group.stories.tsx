import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@workspace/ui/components/toggle-group"
import { useState, type ComponentProps } from "react"

function Example(args: ComponentProps<typeof ToggleGroup>) {
  return (
    <ToggleGroup {...args}>
      <ToggleGroupItem value="light">Light</ToggleGroupItem>
      <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
      <ToggleGroupItem value="system">System</ToggleGroupItem>
    </ToggleGroup>
  )
}
function ControlledExample() {
  const [value, setValue] = useState<string[]>(["system"])
  return (
    <Example
      aria-label="Theme"
      value={value}
      onValueChange={(next) => {
        if (next.length) setValue(next)
      }}
    />
  )
}
const meta = {
  title: "Components/ToggleGroup",
  component: ToggleGroup,
  subcomponents: { ToggleGroupItem },
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    "aria-label": "Theme",
    defaultValue: ["system"],
    orientation: "horizontal",
    multiple: false,
    disabled: false,
  },
  argTypes: {
    defaultValue: { control: "object" },
    orientation: { control: "select", options: ["horizontal", "vertical"] },
    multiple: { control: "boolean" },
    disabled: { control: "boolean" },
  },
  render: (args) => <Example {...args} />,
} satisfies Meta<typeof ToggleGroup>
export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
export const Focus: Story = {
  parameters: {
    pseudo: {
      focus: ['[data-slot="toggle-group-item"][data-pressed]'],
      focusVisible: ['[data-slot="toggle-group-item"][data-pressed]'],
    },
  },
}
export const Disabled: Story = { args: { disabled: true } }
export const Vertical: Story = { args: { orientation: "vertical" } }
export const Multiple: Story = {
  args: {
    "aria-label": "Text formatting",
    multiple: true,
    defaultValue: ["bold", "italic"],
  },
  render: (args) => (
    <ToggleGroup {...args}>
      <ToggleGroupItem value="bold">Bold</ToggleGroupItem>
      <ToggleGroupItem value="italic">Italic</ToggleGroupItem>
      <ToggleGroupItem value="underline">Underline</ToggleGroupItem>
    </ToggleGroup>
  ),
}
export const Controlled: Story = {
  parameters: { controls: { disable: true } },
  render: () => <ControlledExample />,
}
