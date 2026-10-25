import type { Meta, StoryObj } from "@storybook/react-vite"

import {
  RowsAndSelection as reviewRowsAndSelection,
  BadgesAndStatus as reviewBadgesAndStatus,
  SemanticTable as reviewSemanticTable,
} from "../surface-review-fixtures"

const meta = {
  title: "Compositions/Lists and tables",
  parameters: { layout: "padded", controls: { disable: true } },
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

export const RowSelection: Story = { ...reviewRowsAndSelection }
export const StatusAndError: Story = { ...reviewBadgesAndStatus }
export const ConnectionTable: Story = { ...reviewSemanticTable }
