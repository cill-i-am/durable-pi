import type { Meta, StoryObj } from "@storybook/react-vite"
import { Button } from "@workspace/ui/components/button"
import { Spinner } from "@workspace/ui/components/spinner"
const meta = {
  title: "Components/Spinner",
  component: Spinner,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  argTypes: { className: { control: "text" } },
  render: (args) => (
    <div role="status" aria-label="Loading">
      <Spinner {...args} />
    </div>
  ),
} satisfies Meta<typeof Spinner>
export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
export const Sizes: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div role="status" aria-label="Loading" className="flex items-center gap-6">
      <Spinner className="size-4" />
      <Spinner className="size-5" />
      <Spinner className="size-6" />
    </div>
  ),
}
export const InButton: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <Button disabled aria-busy="true">
      <Spinner data-icon="inline-start" />
      Saving…
    </Button>
  ),
}
