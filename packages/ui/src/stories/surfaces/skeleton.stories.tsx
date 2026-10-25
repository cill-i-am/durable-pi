import type { Meta, StoryObj } from "@storybook/react-vite"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { MotionConfig } from "motion/react"

const meta = {
  title: "Components/Skeleton",
  component: Skeleton,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: { className: "h-5 w-56 max-w-full" },
  argTypes: { className: { control: "text" }, style: { control: "object" } },
} satisfies Meta<typeof Skeleton>
export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const Playground: Story = { args: { className: "h-10 w-80 max-w-full" } }
export const Avatar: Story = { args: { className: "size-10 rounded-full" } }
export const TextLines: Story = {
  render: (args) => (
    <div
      role="group"
      aria-label="Loading note"
      aria-busy="true"
      className="flex max-w-sm flex-col gap-2"
    >
      <span className="sr-only" role="status">
        Loading note…
      </span>
      <Skeleton {...args} />
      <Skeleton {...args} className="h-4 w-full" />
      <Skeleton {...args} className="h-4 w-4/5" />
    </div>
  ),
}
export const LoadingRows: Story = {
  render: (args) => (
    <div
      role="group"
      aria-label="Loading skills"
      aria-busy="true"
      className="flex max-w-md flex-col gap-5"
    >
      <span role="status" className="sr-only">
        Loading skills…
      </span>
      {[1, 2, 3].map((row) => (
        <div key={row} className="flex items-center gap-3">
          <Skeleton {...args} className="size-6 shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton {...args} className="h-5 w-3/5" />
            <Skeleton {...args} className="h-4 w-4/5" />
          </div>
        </div>
      ))}
    </div>
  ),
}

export const ReducedMotion: Story = {
  render: (args) => (
    <MotionConfig reducedMotion="always">
      <Skeleton {...args} />
    </MotionConfig>
  ),
}
