import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import { AlertCircleIcon } from "lucide-react"
import { fn } from "storybook/test"

const meta = {
  title: "Components/Alert",
  component: Alert,
  subcomponents: { AlertTitle, AlertDescription, AlertAction },
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    variant: "default",
    appearance: "inline",
    className: "max-w-xl",
    children: (
      <>
        <AlertTitle>Changes saved</AlertTitle>
        <AlertDescription>Your preferences are up to date.</AlertDescription>
      </>
    ),
  },
  argTypes: {
    variant: {
      control: "select",
      options: ["default", "warning", "destructive"],
    },
    appearance: { control: "select", options: ["inline", "panel"] },
    children: { control: false },
    className: { control: "text" },
  },
} satisfies Meta<typeof Alert>
export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const Playground: Story = { args: { appearance: "panel" } }
export const InlineError: Story = {
  args: {
    variant: "destructive",
    children: (
      <>
        <AlertCircleIcon aria-hidden="true" />
        <AlertDescription>Couldn’t save. Try again.</AlertDescription>
      </>
    ),
  },
}
export const WithAction: Story = {
  args: {
    variant: "destructive",
    children: (
      <>
        <AlertCircleIcon aria-hidden="true" />
        <AlertTitle>Couldn’t save</AlertTitle>
        <AlertDescription>Your changes are still here.</AlertDescription>
        <AlertAction>
          <Button variant="outline" onClick={fn()}>
            Retry
          </Button>
        </AlertAction>
      </>
    ),
  },
}
export const Warning: Story = {
  args: {
    variant: "warning",
    appearance: "panel",
    children: (
      <>
        <AlertCircleIcon aria-hidden="true" />
        <AlertTitle>Save not confirmed</AlertTitle>
        <AlertDescription>
          Check the result before trying again.
        </AlertDescription>
      </>
    ),
  },
}
export const LongContent: Story = {
  args: {
    className: "w-80 max-w-full",
    appearance: "panel",
    variant: "destructive",
    children: (
      <>
        <AlertCircleIcon aria-hidden="true" />
        <AlertTitle>We couldn’t reconnect to your calendar</AlertTitle>
        <AlertDescription>
          Your calendar preferences are still saved. Reconnect the account
          before changing events.
        </AlertDescription>
        <AlertAction>
          <Button variant="outline" onClick={fn()}>
            Reconnect
          </Button>
        </AlertAction>
      </>
    ),
  },
}
