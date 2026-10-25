import type { Meta, StoryObj } from "@storybook/react-vite"
import { Badge } from "@workspace/ui/components/badge"
import { CheckIcon } from "lucide-react"

const variants = [
  "default",
  "secondary",
  "outline",
  "destructive",
  "ghost",
  "link",
] as const
const meta = {
  title: "Components/Badge",
  component: Badge,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  args: { variant: "default", children: "New" },
  argTypes: {
    variant: { control: "select", options: variants },
    children: { control: "text" },
    render: { control: false },
  },
} satisfies Meta<typeof Badge>
export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const Playground: Story = {
  args: { variant: "secondary", children: "Version 2" },
}
export const Variants: Story = {
  render: (args) => (
    <div className="flex flex-wrap gap-3">
      {variants.map((variant) => (
        <Badge {...args} key={variant} variant={variant}>
          {variant}
        </Badge>
      ))}
    </div>
  ),
}
export const WithIcon: Story = {
  args: {
    children: (
      <>
        <CheckIcon aria-hidden="true" />
        Ready
      </>
    ),
  },
  argTypes: { children: { control: false } },
}
export const Link: Story = {
  args: {
    variant: "link",
    children: "Version history",
    render: <a href="#version-history" />,
  },
}
export const LongContent: Story = {
  args: {
    variant: "outline",
    className: "max-w-56",
    children: "Shared with the whole family and visiting grandparents",
  },
}
