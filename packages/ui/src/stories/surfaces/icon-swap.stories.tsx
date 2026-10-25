import type { Meta, StoryObj } from "@storybook/react-vite"
import { Status } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { IconSwap } from "@workspace/ui/components/icon-swap"
import { BookmarkIcon, CheckIcon } from "lucide-react"
import { MotionConfig } from "motion/react"
import { useState, type ComponentProps } from "react"
import { expect, userEvent, within } from "storybook/test"

function ShortlistExample(args: ComponentProps<typeof IconSwap>) {
  const [active, setActive] = useState(args.active)
  return (
    <div className="flex flex-wrap items-center gap-4">
      <Button
        variant="outline"
        aria-pressed={active}
        onClick={() => setActive(!active)}
      >
        <IconSwap {...args} active={active} />
        Shortlist
      </Button>
      <Status role="status" className="min-w-32">
        {active ? "Shortlisted" : "Not shortlisted"}
      </Status>
    </div>
  )
}

const meta = {
  title: "Components/IconSwap",
  component: IconSwap,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "A decorative pair for occasional state changes. Both icons stay mounted in the same cell. Keep the accessible name, pressed state and visible label on the owning control. Reduced motion uses a brief opacity fade.",
      },
    },
  },
  args: {
    active: false,
    activeIcon: <CheckIcon aria-hidden="true" />,
    inactiveIcon: <BookmarkIcon aria-hidden="true" />,
  },
  argTypes: {
    active: { control: "boolean" },
    activeIcon: { control: false },
    inactiveIcon: { control: false },
    className: { control: "text" },
  },
} satisfies Meta<typeof IconSwap>
export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const Playground: Story = { args: { active: true } }
export const Interactive: Story = {
  render: (args) => <ShortlistExample {...args} />,
  argTypes: { active: { control: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const owner = canvas.getByRole("button", { name: "Shortlist" })
    await userEvent.click(owner)
    await expect(owner).toHaveAttribute("aria-pressed", "true")
    await expect(canvas.getByRole("status")).toHaveTextContent(/^Shortlisted$/)
  },
}
export const RapidReversal: Story = {
  render: (args) => <ShortlistExample {...args} />,
  argTypes: { active: { control: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const owner = canvas.getByRole("button", { name: "Shortlist" })
    await userEvent.click(owner)
    await userEvent.click(owner)
    await expect(owner).toHaveAttribute("aria-pressed", "false")
    await expect(canvas.getByRole("status")).toHaveTextContent(
      /^Not shortlisted$/
    )
  },
}
export const ReducedMotion: Story = {
  render: (args) => (
    <MotionConfig reducedMotion="always">
      <ShortlistExample {...args} />
    </MotionConfig>
  ),
  argTypes: { active: { control: false } },
}
