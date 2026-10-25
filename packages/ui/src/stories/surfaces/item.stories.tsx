import type { Meta, StoryObj } from "@storybook/react-vite"
import { Button } from "@workspace/ui/components/button"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemHeader,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@workspace/ui/components/item"
import { cn } from "@workspace/ui/lib/utils"
import { BookOpenIcon, ChevronRightIcon } from "lucide-react"
import { useState, type ComponentProps } from "react"
import { expect, fn, userEvent, within } from "storybook/test"

function SelectionExample(args: ComponentProps<typeof Item>) {
  const [selected, setSelected] = useState("weekly")
  return (
    <ItemGroup aria-label="Selected skill" className="max-w-lg gap-1">
      {[
        { value: "weekly", label: "Weekly planning" },
        { value: "meals", label: "Meal planning" },
      ].map(({ value, label }) => (
        <Item
          {...args}
          key={value}
          render={<button type="button" />}
          className={cn(
            args.className,
            selected === value ? "hover:bg-accent" : "hover:bg-muted"
          )}
          variant={selected === value ? "selected" : "default"}
          aria-pressed={selected === value}
          onClick={() => setSelected(value)}
        >
          <ItemContent>
            <ItemTitle>{label}</ItemTitle>
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  )
}

const meta = {
  title: "Components/Item",
  component: Item,
  subcomponents: {
    ItemGroup,
    ItemSeparator,
    ItemMedia,
    ItemContent,
    ItemTitle,
    ItemDescription,
    ItemActions,
    ItemHeader,
    ItemFooter,
  },
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    variant: "default",
    size: "default",
    className: "max-w-lg",
    children: (
      <>
        <ItemMedia>
          <BookOpenIcon aria-hidden="true" />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>Weekly planning</ItemTitle>
          <ItemDescription>Plan meals and activities together.</ItemDescription>
        </ItemContent>
      </>
    ),
  },
  argTypes: {
    variant: {
      control: "select",
      options: ["default", "outline", "muted", "selected"],
    },
    size: { control: "select", options: ["default", "sm", "xs"] },
    children: { control: false },
    render: { control: false },
    className: { control: "text" },
  },
} satisfies Meta<typeof Item>
export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const Playground: Story = { args: { variant: "outline", size: "sm" } }
export const Selected: Story = {
  args: {
    variant: "selected",
    "aria-current": "page",
    render: <a href="#weekly-planning" />,
  },
}
export const WithAction: Story = {
  args: {
    children: (
      <>
        <ItemContent>
          <ItemTitle>Weekly planning</ItemTitle>
          <ItemDescription>Version 2</ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button variant="outline" onClick={fn()}>
            Edit
          </Button>
        </ItemActions>
      </>
    ),
  },
}
export const NavigationList: Story = {
  render: (args) => (
    <ItemGroup aria-label="Skills" className="max-w-lg">
      <Item {...args} render={<a href="#weekly-planning" />}>
        <ItemContent>
          <ItemTitle>Weekly planning</ItemTitle>
          <ItemDescription>Plan the week together.</ItemDescription>
        </ItemContent>
        <ChevronRightIcon aria-hidden="true" />
      </Item>
      <ItemSeparator />
      <Item {...args} render={<a href="#meal-planning" />}>
        <ItemContent>
          <ItemTitle>Meal planning</ItemTitle>
          <ItemDescription>Keep dinner simple.</ItemDescription>
        </ItemContent>
        <ChevronRightIcon aria-hidden="true" />
      </Item>
    </ItemGroup>
  ),
}
export const LongContent: Story = {
  args: {
    className: "w-80 max-w-full",
    children: (
      <ItemContent>
        <ItemTitle>
          Term dates, after-school activities and collection arrangements
        </ItemTitle>
        <ItemDescription>
          school-calendar-for-the-whole-family-and-every-after-school-activity.ics
        </ItemDescription>
      </ItemContent>
    ),
  },
}

export const SelectionFeedback: Story = {
  render: (args) => <SelectionExample {...args} />,
  argTypes: {
    variant: { control: false },
    children: { control: false },
    render: { control: false },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const meals = canvas.getByRole("button", { name: "Meal planning" })
    await userEvent.click(meals)
    await expect(meals).toHaveAttribute("aria-pressed", "true")
    await expect(
      canvas.getByRole("button", { name: "Weekly planning" })
    ).toHaveAttribute("aria-pressed", "false")
  },
}
