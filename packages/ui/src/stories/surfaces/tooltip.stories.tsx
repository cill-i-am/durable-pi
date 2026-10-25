import type { Meta, StoryObj } from "@storybook/react-vite"
import { Button } from "@workspace/ui/components/button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { MoreHorizontalIcon } from "lucide-react"
import { useId, type ComponentProps } from "react"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

function TooltipExample(props: ComponentProps<typeof Tooltip>) {
  const triggerId = useId()
  return (
    <TooltipProvider>
      <Tooltip
        key={String(props.defaultOpen)}
        {...props}
        defaultTriggerId={triggerId}
      >
        <TooltipTrigger
          id={triggerId}
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label="More note actions"
            />
          }
        >
          <MoreHorizontalIcon aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>More note actions</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

const meta = {
  title: "Components/Tooltip",
  component: Tooltip,
  subcomponents: { TooltipProvider, TooltipTrigger, TooltipContent },
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  args: {
    defaultOpen: false,
    disabled: false,
    disableHoverablePopup: false,
    trackCursorAxis: "none",
    onOpenChange: fn(),
  },
  argTypes: {
    defaultOpen: { control: "boolean" },
    disabled: { control: "boolean" },
    disableHoverablePopup: { control: "boolean" },
    trackCursorAxis: { control: "select", options: ["none", "x", "y", "both"] },
    open: { control: false },
    children: { control: false },
    defaultTriggerId: { control: false },
    onOpenChange: { control: false },
  },
  render: (args) => <TooltipExample {...args} />,
} satisfies Meta<typeof Tooltip>
export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const Playground: Story = { args: { defaultOpen: true } }
export const Disabled: Story = { args: { disabled: true } }
export const KeyboardFocus: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const screen = within(canvasElement.ownerDocument.body)
    canvas.getByRole("button", { name: "More note actions" }).focus()
    await expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "More note actions"
    )
    await userEvent.keyboard("{Escape}")
    await waitFor(() =>
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
    )
  },
}
