import type { Meta, StoryObj } from "@storybook/react-vite"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { fn } from "storybook/test"

const meta = {
  title: "Components/Card",
  component: Card,
  subcomponents: {
    CardHeader,
    CardTitle,
    CardDescription,
    CardAction,
    CardContent,
    CardFooter,
  },
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    className: "max-w-md",
    children: (
      <>
        <CardHeader>
          <CardTitle>Notes</CardTitle>
          <CardDescription>Keep useful details together.</CardDescription>
        </CardHeader>
        <CardContent>School closes at 2 pm on Friday.</CardContent>
      </>
    ),
  },
  argTypes: {
    className: { control: "text" },
    children: { control: false },
  },
} satisfies Meta<typeof Card>
export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Playground: Story = {
  args: { className: "max-w-md p-4", children: "A simple content surface." },
  argTypes: { children: { control: "text" } },
}

export const WithAction: Story = {
  args: {
    children: (
      <>
        <CardHeader>
          <CardTitle>Notes</CardTitle>
          <CardDescription>Two details saved.</CardDescription>
          <CardAction>
            <Button variant="outline" onClick={fn()}>
              Edit
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>School closes at 2 pm on Friday.</CardContent>
      </>
    ),
  },
}

export const WithContextFooter: Story = {
  args: {
    children: (
      <>
        <CardHeader>
          <CardTitle>Notes</CardTitle>
        </CardHeader>
        <CardContent>School closes at 2 pm on Friday.</CardContent>
        <CardFooter variant="context">Last edited today.</CardFooter>
      </>
    ),
  },
}

export const LongContent: Story = {
  args: {
    className: "w-80 max-w-full",
    children: (
      <>
        <CardHeader>
          <CardTitle>
            Term dates, after-school activities and collection arrangements
          </CardTitle>
          <CardAction>
            <Button variant="outline" onClick={fn()}>
              Edit note
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="wrap-anywhere">
          school-calendar-for-the-whole-family-and-every-after-school-activity.ics
        </CardContent>
      </>
    ),
  },
}
