import { Drawer } from "@base-ui/react/drawer"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@workspace/ui/components/dialog"
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
import { Separator } from "@workspace/ui/components/separator"
import { useId, useRef, useState, type ComponentProps } from "react"
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

function NativeContractsExample() {
  const [result, setResult] = useState("No action yet.")
  return (
    <div className="flex max-w-sm flex-col gap-4">
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" />}>
          Contract actions
        </DropdownMenuTrigger>
        <DropdownMenuContent
          mobileTitle="Contract actions"
          className={(state) =>
            state.open ? "contract-content-open" : undefined
          }
        >
          <DropdownMenuGroup className={() => "contract-group"}>
            <DropdownMenuLabel className={() => "contract-label"}>
              Native events
            </DropdownMenuLabel>
            <DropdownMenuItem
              data-action="read-target"
              className={(state) =>
                state.highlighted
                  ? "contract-item contract-highlighted"
                  : "contract-item"
              }
              onClick={(event) =>
                setResult(event.currentTarget.dataset.action!)
              }
            >
              Read current target
            </DropdownMenuItem>
            <DropdownMenuItem
              data-action="kept-open"
              closeOnClick={false}
              onClick={(event) =>
                setResult(event.currentTarget.dataset.action!)
              }
            >
              Keep menu open
            </DropdownMenuItem>
            <DropdownMenuItem
              data-action="cancelled"
              onClick={(event) => {
                event.preventBaseUIHandler()
                setResult(event.currentTarget.dataset.action!)
              }}
            >
              Cancel native close
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator className={() => "contract-menu-separator"} />
          <DropdownMenuCheckboxItem
            defaultChecked
            closeOnClick={false}
            className={(state) =>
              state.checked ? "contract-checked" : undefined
            }
          >
            Show descriptions
          </DropdownMenuCheckboxItem>
          <DropdownMenuRadioGroup defaultValue="system" aria-label="Theme">
            <DropdownMenuRadioItem
              value="system"
              className={() => "contract-radio"}
            >
              System theme
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className={() => "contract-sub-trigger"}>
              More actions
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              mobileTitle="More actions"
              mobileBackLabel="Back to contract actions"
            >
              <DropdownMenuItem>Nested action</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
      <Separator
        className={(state) => `contract-separator-${state.orientation}`}
      />
      <output aria-label="Menu click result">{result}</output>
    </div>
  )
}

export const NativeContracts: Story = {
  render: () => <NativeContractsExample />,
}

function NativeDialogHandoffExample() {
  const [dialog] = useState(() => Drawer.createHandle())
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          ref={trigger}
          render={<Button variant="outline" />}
        >
          Skill actions
        </DropdownMenuTrigger>
        <DropdownMenuContent
          mobileTitle="Skill actions"
          finalFocus={() => (dialog.isOpen ? false : trigger.current)}
        >
          <DropdownMenuItem onClick={() => dialog.open(null)}>
            View skill details
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog handle={dialog}>
        <DialogContent finalFocus={trigger}>
          <DialogTitle>Skill details</DialogTitle>
          <DialogDescription>
            Weekly planning is ready to use.
          </DialogDescription>
          <DialogClose render={<Button variant="outline" />}>Done</DialogClose>
        </DialogContent>
      </Dialog>
    </>
  )
}

export const NativeDialogHandoff: Story = {
  render: () => <NativeDialogHandoffExample />,
}

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
