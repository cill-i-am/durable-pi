import type { Meta, StoryObj } from "@storybook/react-vite"
import { Separator } from "@workspace/ui/components/separator"

const meta = {
  title: "Components/Separator",
  component: Separator,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: { orientation: "horizontal" },
  argTypes: {
    orientation: {
      control: "inline-radio",
      options: ["horizontal", "vertical"],
    },
    className: { control: "text" },
  },
  render: (args) =>
    args.orientation === "vertical" ? (
      <div className="flex min-h-11 items-center gap-4">
        <span>Personal</span>
        <Separator {...args} />
        <span>Family</span>
      </div>
    ) : (
      <div className="flex max-w-md flex-col gap-4">
        <span>Personal</span>
        <Separator {...args} />
        <span>Family</span>
      </div>
    ),
} satisfies Meta<typeof Separator>
export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const Playground: Story = { args: { orientation: "vertical" } }
export const Vertical: Story = { args: { orientation: "vertical" } }
export const Decorative: Story = {
  args: { role: "presentation", "aria-hidden": true },
}
