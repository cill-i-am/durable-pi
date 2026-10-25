import type { Meta, StoryObj } from "@storybook/react-vite"
import { Button } from "@workspace/ui/components/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty"
import { BookOpenIcon, SearchIcon } from "lucide-react"
import { fn } from "storybook/test"

const meta = {
  title: "Components/Empty",
  component: Empty,
  subcomponents: {
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
    EmptyDescription,
    EmptyContent,
  },
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    className: "max-w-lg",
    children: (
      <>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BookOpenIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No skills yet</EmptyTitle>
          <EmptyDescription>
            Add instructions your assistant can reuse.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={fn()}>Add skill</Button>
        </EmptyContent>
      </>
    ),
  },
  argTypes: { className: { control: "text" }, children: { control: false } },
} satisfies Meta<typeof Empty>
export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const Playground: Story = { args: { className: "w-80 max-w-full" } }
export const NoResults: Story = {
  args: {
    children: (
      <EmptyHeader>
        <EmptyMedia>
          <SearchIcon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>No matching skills</EmptyTitle>
        <EmptyDescription>Try a different name.</EmptyDescription>
      </EmptyHeader>
    ),
  },
}
export const WithoutMedia: Story = {
  args: {
    children: (
      <>
        <EmptyHeader>
          <EmptyTitle>No notes yet</EmptyTitle>
          <EmptyDescription>Save a useful detail for later.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" onClick={fn()}>
            Add note
          </Button>
        </EmptyContent>
      </>
    ),
  },
}
export const LongContent: Story = {
  args: {
    className: "w-80 max-w-full",
    children: (
      <EmptyHeader>
        <EmptyTitle>
          No shared instructions for after-school activities
        </EmptyTitle>
        <EmptyDescription>
          Keep collection times, contact details and changes to the usual
          routine in one place.
        </EmptyDescription>
      </EmptyHeader>
    ),
  },
}
