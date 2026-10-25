import type { Meta, StoryObj } from "@storybook/react-vite"

import {
  EmptyState as reviewEmptyState,
  LoadingState as reviewLoadingState,
  ErrorAndRetry as reviewErrorAndRetry,
  CancelPending as reviewCancelPending,
  UnconfirmedResult as reviewUnconfirmedResult,
  MenuFailureAndRetry as reviewMenuFailureAndRetry,
} from "../surface-review-fixtures"

const meta = {
  title: "Compositions/Recovery",
  parameters: { layout: "padded", controls: { disable: true } },
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

export const EmptyToPopulated: Story = { ...reviewEmptyState }
export const LoadingConnections: Story = { ...reviewLoadingState }
export const FailedSaveRetry: Story = { ...reviewErrorAndRetry }
export const CancelSave: Story = { ...reviewCancelPending }
export const UnconfirmedSave: Story = { ...reviewUnconfirmedResult }
export const FailedMenuAction: Story = { ...reviewMenuFailureAndRetry }
