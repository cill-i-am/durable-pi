import type { Meta, StoryObj } from "@storybook/react-vite"

import {
  MenuKeyboardAndSelections as reviewMenuKeyboardAndSelections,
  TooltipAndIconAction as reviewTooltipAndIconAction,
} from "../surface-review-fixtures"

const meta = {
  title: "Compositions/Interactions",
  parameters: { layout: "padded", controls: { disable: true } },
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

export const MenuKeyboardAndSelections: Story = {
  ...reviewMenuKeyboardAndSelections,
}
export const TooltipFocus: Story = { ...reviewTooltipAndIconAction }
