import type { Meta, StoryObj } from "@storybook/react-vite"
import { Button } from "@workspace/ui/components/button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

function SharedTooltips({ delay }: { delay?: number }) {
  return (
    <TooltipProvider delay={delay}>
      <div className="flex flex-wrap gap-3">
        {["Family notes", "Shared lists"].map((label) => (
          <Tooltip key={label}>
            <TooltipTrigger render={<Button variant="outline" />}>
              {label}
            </TooltipTrigger>
            <TooltipContent
              className={(state) =>
                state.open ? "tooltip-caller-open" : "tooltip-caller-closed"
              }
            >
              Open {label.toLowerCase()}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  )
}

const meta = {
  title: "Components/Tooltip",
  parameters: { layout: "padded" },
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

export const SharedProvider: Story = { render: () => <SharedTooltips /> }
export const ImmediatePointer: Story = {
  render: () => <SharedTooltips delay={0} />,
}
