import type { Meta, StoryObj } from "@storybook/react-vite"
import { Button } from "@workspace/ui/components/button"
import {
  CardFrame,
  CardFrameAction,
  CardFrameDescription,
  CardFrameFooter,
  CardFrameHeader,
  CardFrameTitle,
  CardPanel,
} from "@workspace/ui/components/card"
import { fn } from "storybook/test"

const meta = {
  title: "Components/CardFrame",
  component: CardFrame,
  subcomponents: {
    CardFrameHeader,
    CardFrameTitle,
    CardFrameDescription,
    CardFrameAction,
    CardPanel,
    CardFrameFooter,
  },
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    className: "max-w-md",
    children: (
      <>
        <CardFrameHeader>
          <CardFrameTitle>Notes</CardFrameTitle>
        </CardFrameHeader>
        <CardPanel className="p-4">School closes at 2 pm on Friday.</CardPanel>
      </>
    ),
  },
  argTypes: { className: { control: "text" }, children: { control: false } },
} satisfies Meta<typeof CardFrame>
export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Playground: Story = {
  args: { children: <CardPanel className="p-4">One inset panel.</CardPanel> },
}

export const HeaderAndAction: Story = {
  args: {
    children: (
      <>
        <CardFrameHeader>
          <CardFrameTitle>Notes</CardFrameTitle>
          <CardFrameDescription>
            Details shared with your family.
          </CardFrameDescription>
          <CardFrameAction>
            <Button variant="outline" onClick={fn()}>
              Add note
            </Button>
          </CardFrameAction>
        </CardFrameHeader>
        <CardPanel className="p-4">School closes at 2 pm on Friday.</CardPanel>
      </>
    ),
  },
}

export const SeparatePanels: Story = {
  args: {
    children: (
      <>
        <CardFrameHeader>
          <CardFrameTitle>Notes</CardFrameTitle>
        </CardFrameHeader>
        <CardPanel className="p-4">School closes at 2 pm on Friday.</CardPanel>
        <CardPanel className="p-4">Bring a packed lunch on Monday.</CardPanel>
      </>
    ),
  },
}

export const ContextFooter: Story = {
  args: {
    children: (
      <>
        <CardPanel className="p-4">School closes at 2 pm on Friday.</CardPanel>
        <CardFrameFooter variant="context">Last edited today.</CardFrameFooter>
      </>
    ),
  },
}

export const ActionFooter: Story = {
  args: {
    children: (
      <>
        <CardPanel className="p-4">Ready to save your changes.</CardPanel>
        <CardFrameFooter variant="actions">
          <Button variant="outline" onClick={fn()}>
            Cancel
          </Button>
          <Button onClick={fn()}>Save changes</Button>
        </CardFrameFooter>
      </>
    ),
  },
}

export const SplitFooter: Story = {
  args: {
    children: (
      <>
        <CardPanel className="p-4">Ready to save your changes.</CardPanel>
        <CardFrameFooter variant="split">
          <span>Only you can edit this note.</span>
          <Button onClick={fn()}>Save changes</Button>
        </CardFrameFooter>
      </>
    ),
  },
}

export const NarrowNight: Story = {
  globals: { theme: "dark" },
  args: { className: "w-80 max-w-full" },
}
