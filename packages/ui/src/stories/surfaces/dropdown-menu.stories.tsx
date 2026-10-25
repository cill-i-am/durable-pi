import type { Meta, StoryObj } from "@storybook/react-vite"
import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { useId, type ComponentProps } from "react"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

function MenuExample(props: ComponentProps<typeof DropdownMenu>) {
  const triggerId = useId()
  return (
    <DropdownMenu
      key={String(props.defaultOpen)}
      {...props}
      defaultTriggerId={triggerId}
    >
      <DropdownMenuTrigger id={triggerId} render={<Button variant="outline" />}>
        Note actions
      </DropdownMenuTrigger>
      <DropdownMenuContent mobileTitle="Note actions">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Note</DropdownMenuLabel>
          <DropdownMenuItem onClick={fn()}>
            Edit<DropdownMenuShortcut>⌘E</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled>Duplicate</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem defaultChecked closeOnClick={false}>
          Show descriptions
        </DropdownMenuCheckboxItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Theme</DropdownMenuSubTrigger>
          <DropdownMenuSubContent mobileTitle="Theme">
            <DropdownMenuRadioGroup defaultValue="system" aria-label="Theme">
              <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">
                System
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={fn()}>
          Archive
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const meta = {
  title: "Components/DropdownMenu",
  component: DropdownMenu,
  subcomponents: {
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuLabel,
    DropdownMenuItem,
    DropdownMenuCheckboxItem,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSub,
    DropdownMenuSubTrigger,
    DropdownMenuSubContent,
    DropdownMenuSeparator,
    DropdownMenuShortcut,
  },
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  args: {
    defaultOpen: false,
    disabled: false,
    loopFocus: true,
    highlightItemOnHover: true,
    modal: true,
    onOpenChange: fn(),
  },
  argTypes: {
    defaultOpen: { control: "boolean" },
    disabled: { control: "boolean" },
    loopFocus: { control: "boolean" },
    highlightItemOnHover: { control: "boolean" },
    modal: { control: "boolean" },
    withinMenubar: { control: "boolean" },
    open: { control: false },
    children: { control: false },
    defaultTriggerId: { control: false },
    onOpenChange: { control: false },
  },
  render: (args) => <MenuExample {...args} />,
} satisfies Meta<typeof DropdownMenu>
export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const Playground: Story = { args: { defaultOpen: true } }
export const Disabled: Story = { args: { disabled: true } }
export const NonModal: Story = { args: { modal: false } }
export const Keyboard: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const screen = within(canvasElement.ownerDocument.body)
    const trigger = canvas.getByRole("button", { name: "Note actions" })
    trigger.focus()
    await userEvent.keyboard("{ArrowDown}")
    await expect(await screen.findByRole("menu")).toBeVisible()
    await userEvent.keyboard("{End}")
    await expect(
      screen.getByRole("menuitem", { name: /^Archive$/ })
    ).toHaveFocus()
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(trigger).toHaveFocus())
  },
}
