import type { Meta, StoryObj } from "@storybook/react-vite"

import {
  CardAnatomies as reviewCardAnatomies,
  CardHeaderInside as reviewCardHeaderInside,
  FrameHeaderAction as reviewFrameHeaderAction,
  FrameContextFooter as reviewFrameContextFooter,
  FrameActionFooter as reviewFrameActionFooter,
  SeparatedPanels as reviewSeparatedPanels,
  NightNarrow as reviewNightNarrow,
  ContextFooterOnly as reviewContextFooterOnly,
  ActionFooterOnly as reviewActionFooterOnly,
  SplitActionFooter as reviewSplitActionFooter,
  SplitActionNight as reviewSplitActionNight,
  LongContentAndNarrow as reviewLongContentAndNarrow,
} from "../surface-review-fixtures"

const meta = {
  title: "Compositions/Card recipes",
  parameters: { layout: "padded", controls: { disable: true } },
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

export const Overview: Story = { ...reviewCardAnatomies }
export const InsideHeader: Story = { ...reviewCardHeaderInside }
export const HeaderAction: Story = { ...reviewFrameHeaderAction }
export const HeaderAndContext: Story = { ...reviewFrameContextFooter }
export const HeaderAndActions: Story = { ...reviewFrameActionFooter }
export const SeparatedPanels: Story = { ...reviewSeparatedPanels }
export const NarrowNight: Story = { ...reviewNightNarrow }
export const ContextFooterOnly: Story = { ...reviewContextFooterOnly }
export const ActionFooterOnly: Story = { ...reviewActionFooterOnly }
export const SplitActions: Story = { ...reviewSplitActionFooter }
export const SplitActionsNight: Story = { ...reviewSplitActionNight }
export const LongContentAndNarrow: Story = { ...reviewLongContentAndNarrow }
