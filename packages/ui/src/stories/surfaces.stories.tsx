import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@workspace/ui/components/alert"
import { Badge, Status } from "@workspace/ui/components/badge"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardFrame,
  CardFrameAction,
  CardFrameDescription,
  CardFrameFooter,
  CardFrameHeader,
  CardFrameTitle,
  CardPanel,
} from "@workspace/ui/components/card"
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
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty"
import { Field, FieldGroup, FieldLabel } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@workspace/ui/components/item"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Separator } from "@workspace/ui/components/separator"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { Spinner } from "@workspace/ui/components/spinner"
import { Switch } from "@workspace/ui/components/switch"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { Textarea } from "@workspace/ui/components/textarea"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@workspace/ui/components/toggle-group"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import {
  AlertCircleIcon,
  ArrowUpRightIcon,
  BookOpenIcon,
  BookmarkIcon,
  CheckIcon,
  ChevronRightIcon,
  FileIcon,
  MoreHorizontalIcon,
  PlusIcon,
  Settings2Icon,
} from "lucide-react"
import { useId, useState, type ReactNode } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { useLab } from "./state/use-lab"

const meta = {
  title: "Surfaces/Cards and frames",
  component: CardFrame,
  tags: ["autodocs"],
  parameters: { layout: "padded", controls: { disable: true } },
} satisfies Meta<typeof CardFrame>
export default meta
type Story = StoryObj<typeof meta>
type Scenario = "success" | "error" | "uncertain" | "hold"
type Lab = ReturnType<typeof useLab>

function Specimen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-4">
      <h2 className="text-md font-semibold">{title}</h2>
      {children}
    </section>
  )
}

function ThemeRow() {
  const label = useId()
  const [value, setValue] = useState(["system"])
  return (
    <Item>
      <ItemContent>
        <ItemTitle id={label}>Theme</ItemTitle>
      </ItemContent>
      <ItemActions>
        <ToggleGroup
          aria-labelledby={label}
          value={value}
          onValueChange={(next) => {
            if (next.length) setValue(next)
          }}
        >
          <ToggleGroupItem value="light">Light</ToggleGroupItem>
          <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
          <ToggleGroupItem value="system">System</ToggleGroupItem>
        </ToggleGroup>
      </ItemActions>
    </Item>
  )
}

function MotionRow() {
  const id = useId()
  return (
    <Item>
      <ItemContent>
        <ItemTitle>
          <label htmlFor={id}>Activity animations</label>
        </ItemTitle>
      </ItemContent>
      <ItemActions>
        <Switch id={id} defaultChecked />
      </ItemActions>
    </Item>
  )
}

function AppearanceRows() {
  return (
    <ItemGroup aria-label="Appearance">
      <ThemeRow />
      <ItemSeparator />
      <MotionRow />
    </ItemGroup>
  )
}

function InsideCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <AppearanceRows />
      </CardContent>
    </Card>
  )
}

function SkillRows({
  names = ["Weekly planning", "Meal planning"],
}: {
  names?: string[]
}) {
  const [action, setAction] = useState("")
  return (
    <>
      <ItemGroup aria-label="Skills">
        {names.map((skill, index) => (
          <Item
            key={skill}
            className={index ? "border-t border-border" : undefined}
          >
            <ItemMedia>
              <BookOpenIcon aria-hidden="true" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{skill}</ItemTitle>
            </ItemContent>
            <ItemActions>
              <span className="w-5 text-right text-sm text-muted-foreground">
                v{2 - index}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`${skill} actions`}
                    />
                  }
                >
                  <MoreHorizontalIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  mobileTitle={`${skill} actions`}
                >
                  <DropdownMenuGroup>
                    {["Edit", "Version history", "Archive"].map((name) => (
                      <DropdownMenuItem
                        key={name}
                        onClick={() =>
                          setAction(`${name} selected for ${skill}.`)
                        }
                      >
                        {name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
      {action && (
        <p role="status" className="px-3 pb-3 text-sm text-muted-foreground">
          {action}
        </p>
      )}
    </>
  )
}

function HeaderAction() {
  const [adding, setAdding] = useState(false)
  const id = useId()
  return (
    <CardFrame>
      <CardFrameHeader>
        <CardFrameTitle>Skills</CardFrameTitle>
        <CardFrameAction>
          <Button variant="outline" onClick={() => setAdding(!adding)}>
            <PlusIcon data-icon="inline-start" />
            {adding ? "Cancel" : "Add"}
          </Button>
        </CardFrameAction>
      </CardFrameHeader>
      <CardPanel>
        <SkillRows />
      </CardPanel>
      {adding && (
        <CardPanel>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={id}>Skill name</FieldLabel>
                <Input id={id} placeholder="Weekly planning" />
              </Field>
            </FieldGroup>
          </CardContent>
        </CardPanel>
      )}
    </CardFrame>
  )
}

function ModelField({
  effort = false,
  disabled = false,
}: {
  effort?: boolean
  disabled?: boolean
}) {
  const id = useId()
  const items = effort
    ? [
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
      ]
    : [
        { value: "sol", label: "GPT-6.1 Sol" },
        { value: "astra", label: "GPT-6 Astra" },
      ]
  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor={id}>
          {effort ? "Reasoning effort" : "Model"}
        </FieldLabel>
        <Select
          disabled={disabled}
          defaultValue={items[0]!.value}
          items={items}
        >
          <SelectTrigger id={id}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent mobileTitle={effort ? "Reasoning effort" : "Model"}>
            <SelectGroup>
              {items.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
    </FieldGroup>
  )
}

function ContextFooter() {
  return (
    <CardFrame>
      <CardFrameHeader>
        <CardFrameTitle>Models</CardFrameTitle>
        <CardFrameDescription>Defaults for new jobs.</CardFrameDescription>
      </CardFrameHeader>
      <CardPanel>
        <CardContent>
          <ModelField />
        </CardContent>
      </CardPanel>
      <CardFrameFooter>Running jobs keep their model.</CardFrameFooter>
    </CardFrame>
  )
}

function Outcome({ lab }: { lab: Lab }) {
  if (lab.status === "error")
    return (
      <Alert variant="destructive">
        <AlertCircleIcon aria-hidden="true" />
        <AlertTitle>Couldn’t save</AlertTitle>
        <AlertDescription>{lab.error}</AlertDescription>
        <AlertAction>
          <Button variant="outline" onClick={lab.retry}>
            Retry
          </Button>
        </AlertAction>
      </Alert>
    )
  if (lab.status === "uncertain")
    return (
      <Alert variant="warning">
        <AlertCircleIcon aria-hidden="true" />
        <AlertTitle>Save not confirmed</AlertTitle>
        <AlertDescription>
          Check the result before trying again.
        </AlertDescription>
        <AlertAction>
          <Button variant="outline" onClick={lab.check}>
            Check result
          </Button>
        </AlertAction>
      </Alert>
    )
  if (lab.status === "success")
    return (
      <Status role="status">
        <CheckIcon aria-hidden="true" />
        Saved in this simulation.
      </Status>
    )
  if (lab.status === "cancelled")
    return <Status role="status">Cancelled. No automatic retry.</Status>
  return null
}

function InstructionForm({
  scenario = "success",
  modelDefaults = false,
}: {
  scenario?: Scenario
  modelDefaults?: boolean
}) {
  const id = useId()
  const lab = useLab({ scenario, delayMs: 650 })
  const [draft, setDraft] = useState(
    "Use short sentences. Prefer plain language."
  )
  return (
    <CardFrame>
      {!modelDefaults && (
        <CardFrameHeader>
          <CardFrameTitle>Instructions</CardFrameTitle>
        </CardFrameHeader>
      )}
      <CardPanel aria-busy={lab.busy}>
        <CardContent>
          {modelDefaults ? (
            <>
              <ModelField disabled={!lab.ready || lab.status !== "idle"} />
              <div className="my-3">
                <Separator />
              </div>
              <ModelField
                effort
                disabled={!lab.ready || lab.status !== "idle"}
              />
              <p className="mt-3 text-sm text-muted-foreground">
                Running jobs keep their model.
              </p>
            </>
          ) : (
            <FieldGroup>
              <Field>
                <FieldLabel className="sr-only" htmlFor={id}>
                  Instructions
                </FieldLabel>
                <Textarea
                  id={id}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  disabled={!lab.ready || lab.status !== "idle"}
                  className="min-h-28"
                />
              </Field>
            </FieldGroup>
          )}
          {(lab.status === "error" ||
            lab.status === "uncertain" ||
            lab.status === "success" ||
            lab.status === "cancelled") && (
            <div className="mt-3">
              <Outcome lab={lab} />
            </div>
          )}
        </CardContent>
      </CardPanel>
      <CardFrameFooter variant="actions">
        <Button
          variant="outline"
          disabled={!lab.ready || lab.status === "uncertain"}
          onClick={() => {
            if (lab.busy) lab.cancel()
            else {
              setDraft("Use short sentences. Prefer plain language.")
              lab.reset()
            }
          }}
        >
          {lab.busy ? "Cancel request" : "Cancel changes"}
        </Button>
        <Button
          {...lab.interactionProps}
          disabled={lab.disabled || lab.status !== "idle"}
          onClick={lab.start}
        >
          {lab.busy && <Spinner data-icon="inline-start" />}
          {lab.busy
            ? "Working…"
            : modelDefaults
              ? "Save default"
              : "Save changes"}
        </Button>
      </CardFrameFooter>
    </CardFrame>
  )
}

function Separated() {
  return (
    <CardFrame>
      <CardFrameHeader>
        <CardFrameTitle>Appearance</CardFrameTitle>
      </CardFrameHeader>
      <CardPanel>
        <ItemGroup>
          <ThemeRow />
        </ItemGroup>
      </CardPanel>
      <CardPanel>
        <ItemGroup>
          <MotionRow />
        </ItemGroup>
      </CardPanel>
    </CardFrame>
  )
}

function Connections() {
  const lab = useLab()
  return (
    <CardFrame>
      <CardFrameHeader>
        <CardFrameTitle>Connections</CardFrameTitle>
        <CardFrameAction>
          <Button
            variant="outline"
            disabled={lab.disabled || lab.status !== "idle"}
            onClick={lab.start}
          >
            {lab.busy ? "Connecting…" : "Connect"}
          </Button>
        </CardFrameAction>
      </CardFrameHeader>
      <CardPanel>
        <ItemGroup aria-label="Connections">
          {["ChatGPT", "Google"].map((name, index) => (
            <Item
              key={name}
              className={index ? "border-t border-border" : undefined}
            >
              <ItemMedia>
                <CheckIcon aria-hidden="true" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{name}</ItemTitle>
              </ItemContent>
              <ItemActions>
                <Status>Connected</Status>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      </CardPanel>
      <CardFrameFooter>
        {lab.status === "success" ? (
          <Status role="status">Added in this simulation.</Status>
        ) : (
          "Shared with your family."
        )}
      </CardFrameFooter>
    </CardFrame>
  )
}

function Product() {
  const [shortlisted, setShortlisted] = useState(false)
  return (
    <CardFrame>
      <CardPanel>
        <CardContent className="flex flex-col gap-4 p-5">
          <div className="flex flex-col gap-2">
            <CardTitle>Travel wireless</CardTitle>
            <p className="text-base text-muted-foreground">Example retailer</p>
            <p className="text-xl font-semibold tabular-nums">€229.00</p>
          </div>
          <p className="text-base text-muted-foreground">
            A lighter pair that folds for travel.
          </p>
          <Badge variant="outline">Illustrative product</Badge>
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Battery</dt>
            <dd className="text-right font-medium tabular-nums">40 hours</dd>
            <dt className="text-muted-foreground">Weight</dt>
            <dd className="text-right font-medium tabular-nums">210 g</dd>
            <dt className="text-muted-foreground">Noise cancelling</dt>
            <dd className="text-right font-medium">Yes</dd>
          </dl>
        </CardContent>
      </CardPanel>
      <CardFrameFooter variant="split" className="px-5">
        <Button
          variant="ghost"
          aria-pressed={shortlisted}
          onClick={() => setShortlisted(!shortlisted)}
        >
          <BookmarkIcon data-icon="inline-start" />
          {shortlisted ? "Shortlisted" : "Shortlist"}
        </Button>
        <a
          data-slot="button"
          className={buttonVariants({ variant: "outline" })}
          href="https://example.com"
          target="_blank"
          rel="noreferrer"
        >
          View retailer
          <ArrowUpRightIcon aria-hidden="true" data-icon="inline-end" />
        </a>
      </CardFrameFooter>
    </CardFrame>
  )
}

export const CardAnatomies: Story = {
  render: () => (
    <div className="grid max-w-[90rem] grid-cols-1 items-start gap-8 md:grid-cols-2 xl:grid-cols-3">
      <Specimen title="Card header">
        <InsideCard />
      </Specimen>
      <Specimen title="Frame header + action">
        <HeaderAction />
      </Specimen>
      <Specimen title="Header + context footer">
        <ContextFooter />
      </Specimen>
      <Specimen title="Header + action footer">
        <InstructionForm />
      </Specimen>
      <Specimen title="Separated panels">
        <Separated />
      </Specimen>
      <Specimen title="320 px · Night">
        <div className="dark rounded-[16px] bg-background p-5 text-foreground">
          <div className="w-80 max-w-full">
            <Connections />
          </div>
        </div>
      </Specimen>
    </div>
  ),
}
export const CardHeaderInside: Story = {
  render: () => (
    <div className="max-w-[27rem]">
      <InsideCard />
    </div>
  ),
}
export const FrameHeaderAction: Story = {
  render: () => (
    <div className="max-w-[27rem]">
      <HeaderAction />
    </div>
  ),
}
export const FrameContextFooter: Story = {
  render: () => (
    <div className="max-w-[27rem]">
      <ContextFooter />
    </div>
  ),
}
export const FrameActionFooter: Story = {
  render: () => (
    <div className="max-w-[27rem]">
      <InstructionForm />
    </div>
  ),
}
export const SeparatedPanels: Story = {
  render: () => (
    <div className="max-w-[27rem]">
      <Separated />
    </div>
  ),
}
export const NightNarrow: Story = {
  globals: { theme: "dark" },
  render: () => (
    <div className="w-80 max-w-full">
      <Connections />
    </div>
  ),
}
export const ContextFooterOnly: Story = {
  render: () => (
    <div className="max-w-[35rem]">
      <CardFrame>
        <CardPanel>
          <AppearanceRows />
        </CardPanel>
        <CardFrameFooter>On this device.</CardFrameFooter>
      </CardFrame>
    </div>
  ),
}
export const ActionFooterOnly: Story = {
  render: () => (
    <div className="max-w-[35rem]">
      <InstructionForm modelDefaults />
    </div>
  ),
}
export const SplitActionFooter: Story = {
  render: () => (
    <div className="max-w-[35rem]">
      <Product />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: /^Shortlist$/ }))
    await expect(
      canvas.getByRole("button", { name: "Shortlisted" })
    ).toHaveAttribute("aria-pressed", "true")
  },
}
export const SplitActionNight: Story = {
  globals: { theme: "dark" },
  render: () => (
    <div className="w-80 max-w-full">
      <Product />
    </div>
  ),
}

function RowExample() {
  const [current, setCurrent] = useState("Preferences")
  return (
    <CardFrame>
      <CardPanel>
        <ItemGroup aria-label="Workspace sections">
          {["Preferences", "Weekly planning"].map((name, index) => (
            <Item
              key={name}
              variant={current === name ? "selected" : "default"}
              render={
                <a
                  href={`#section-${index}`}
                  aria-current={current === name ? "page" : undefined}
                  onClick={(event) => {
                    event.preventDefault()
                    setCurrent(name)
                  }}
                />
              }
            >
              <ItemMedia>
                {index ? (
                  <BookOpenIcon aria-hidden="true" />
                ) : (
                  <Settings2Icon aria-hidden="true" />
                )}
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{name}</ItemTitle>
                {index === 1 && (
                  <ItemDescription>
                    Turn plans into clear next steps.
                  </ItemDescription>
                )}
              </ItemContent>
              <ItemActions>
                <ChevronRightIcon aria-hidden="true" className="size-[18px]" />
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      </CardPanel>
      <CardFrameFooter role="status">{current} selected.</CardFrameFooter>
    </CardFrame>
  )
}
export const RowsAndSelection: Story = {
  render: () => (
    <div className="max-w-[35rem]">
      <RowExample />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("link", { name: /Weekly planning/ }))
    await expect(
      canvas.getByRole("link", { name: /Weekly planning/ })
    ).toHaveAttribute("aria-current", "page")
  },
}
export const BadgesAndStatus: Story = {
  render: () => (
    <div className="flex max-w-[35rem] flex-col gap-6">
      <div className="flex flex-wrap gap-3">
        <Badge>New</Badge>
        <Badge variant="secondary">Version 2</Badge>
        <Badge variant="outline">Illustrative product</Badge>
        <Badge variant="destructive">Needs attention</Badge>
        <Badge variant="ghost">Archived</Badge>
        <Badge variant="link" render={<a href="#history" />}>
          History
        </Badge>
      </div>
      <div className="flex flex-wrap gap-6">
        <Status>
          <CheckIcon aria-hidden="true" />
          Connected
        </Status>
        <Status tone="warning">Unconfirmed</Status>
        <Status tone="destructive">Couldn’t connect</Status>
      </div>
      <Alert variant="destructive">
        <AlertCircleIcon aria-hidden="true" />
        <AlertDescription>Couldn’t save. Try again.</AlertDescription>
      </Alert>
    </div>
  ),
}

function EmptyExample() {
  const lab = useLab()
  return (
    <CardFrame>
      <CardFrameHeader>
        <CardFrameTitle>Skills</CardFrameTitle>
      </CardFrameHeader>
      <CardPanel aria-busy={lab.busy}>
        {lab.status === "success" ? (
          <SkillRows names={["Weekly planning"]} />
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BookOpenIcon aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>No skills yet</EmptyTitle>
              <EmptyDescription>
                Add a skill to give your assistant a repeatable task.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button disabled={lab.disabled} onClick={lab.start}>
                {lab.busy && <Spinner data-icon="inline-start" />}
                {lab.busy ? "Adding…" : "Add skill"}
              </Button>
            </EmptyContent>
          </Empty>
        )}
      </CardPanel>
      {lab.status === "success" && (
        <CardFrameFooter role="status">
          Added in this simulation.
        </CardFrameFooter>
      )}
    </CardFrame>
  )
}
export const EmptyState: Story = {
  render: () => (
    <div className="max-w-[27rem]">
      <EmptyExample />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const button = canvas.getByRole("button", { name: "Add skill" })
    await waitFor(() => expect(button).toBeEnabled())
    await userEvent.click(button)
    await expect(
      await canvas.findByText("Added in this simulation.")
    ).toBeVisible()
  },
}
export const LoadingState: Story = {
  render: () => (
    <div className="max-w-[27rem]">
      <CardFrame>
        <CardFrameHeader>
          <CardFrameTitle>Connections</CardFrameTitle>
          <CardFrameAction>
            <Button variant="outline" disabled>
              <Spinner data-icon="inline-start" />
              Loading…
            </Button>
          </CardFrameAction>
        </CardFrameHeader>
        <CardPanel
          role="group"
          aria-busy="true"
          aria-label="Loading connections"
        >
          <div className="flex flex-col gap-5 p-4">
            {[1, 2, 3].map((row) => (
              <div key={row} className="flex items-center gap-3">
                <Skeleton className="size-6 shrink-0" />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <Skeleton className="h-5 w-3/5" />
                  <Skeleton className="h-4 w-4/5" />
                </div>
              </div>
            ))}
          </div>
        </CardPanel>
        <CardFrameFooter role="status">Loading connections…</CardFrameFooter>
      </CardFrame>
    </div>
  ),
}

async function startSave(canvasElement: HTMLElement) {
  const canvas = within(canvasElement)
  const button = canvas.getByRole("button", { name: "Save changes" })
  await waitFor(() => expect(button).toBeEnabled())
  await userEvent.click(button)
  return canvas
}
export const ErrorAndRetry: Story = {
  render: () => (
    <div className="max-w-[27rem]">
      <InstructionForm scenario="error" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = await startSave(canvasElement)
    await expect(await canvas.findByText("Couldn’t save")).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }))
    await expect(
      await canvas.findByText("Saved in this simulation.")
    ).toBeVisible()
  },
}
export const CancelPending: Story = {
  render: () => (
    <div className="max-w-[27rem]">
      <InstructionForm scenario="hold" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = await startSave(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Cancel request" })
    )
    await expect(
      await canvas.findByText("Cancelled. No automatic retry.")
    ).toBeVisible()
  },
}
export const UnconfirmedResult: Story = {
  render: () => (
    <div className="max-w-[27rem]">
      <InstructionForm scenario="uncertain" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = await startSave(canvasElement)
    await expect(await canvas.findByText("Save not confirmed")).toBeVisible()
    await expect(
      canvas.getByRole("button", { name: "Save changes" })
    ).toBeDisabled()
    await userEvent.click(canvas.getByRole("button", { name: "Check result" }))
    await expect(
      await canvas.findByText("Saved in this simulation.")
    ).toBeVisible()
  },
}

function MenuExample({ scenario = "success" }: { scenario?: Scenario }) {
  const [descriptions, setDescriptions] = useState(true)
  const [theme, setTheme] = useState("system")
  const [choice, setChoice] = useState("")
  const lab = useLab({ scenario, delayMs: 650 })
  return (
    <div className="flex max-w-[35rem] flex-col items-start gap-5">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              disabled={lab.disabled || lab.status !== "idle"}
            />
          }
        >
          Skill actions
          <MoreHorizontalIcon data-icon="inline-end" />
        </DropdownMenuTrigger>
        <DropdownMenuContent mobileTitle="Skill actions">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Weekly planning</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => setChoice("Edit selected.")}>
              Edit<DropdownMenuShortcut>⌘E</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => setChoice("Version history selected.")}
            >
              Version history
            </DropdownMenuItem>
            <DropdownMenuItem disabled>Duplicate</DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuCheckboxItem
              checked={descriptions}
              onCheckedChange={setDescriptions}
              closeOnClick={false}
            >
              Show descriptions
            </DropdownMenuCheckboxItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Appearance</DropdownMenuSubTrigger>
              <DropdownMenuSubContent mobileTitle="Appearance">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Theme</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={theme}
                    onValueChange={setTheme}
                  >
                    <DropdownMenuRadioItem value="light">
                      Light
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="dark">
                      Dark
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="system">
                      System
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem variant="destructive" onClick={lab.start}>
              Archive
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <p role="status" className="text-sm text-muted-foreground">
        Theme: {theme}. Descriptions: {descriptions ? "shown" : "hidden"}.{" "}
        {choice}
      </p>
      {lab.busy && (
        <Status role="status">
          <Spinner />
          Working…
        </Status>
      )}
      <Outcome lab={lab} />
      {lab.status !== "idle" && !lab.busy && (
        <Button variant="outline" onClick={lab.reset}>
          Reset simulation
        </Button>
      )}
    </div>
  )
}
export const MenuKeyboardAndSelections: Story = {
  render: () => <MenuExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      screen = within(canvasElement.ownerDocument.body)
    const trigger = canvas.getByRole("button", { name: "Skill actions" })
    await waitFor(() => expect(trigger).toBeEnabled())
    trigger.focus()
    await userEvent.keyboard("{ArrowDown}")
    await expect(await screen.findByRole("menu")).toBeVisible()
    await userEvent.keyboard("{End}")
    await expect(
      screen.getByRole("menuitem", { name: /^Archive$/ })
    ).toHaveFocus()
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(trigger).toHaveFocus())
    await userEvent.click(trigger)
    await userEvent.click(
      await screen.findByRole("menuitemcheckbox", { name: "Show descriptions" })
    )
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "Descriptions: hidden"
    )
    await userEvent.click(screen.getByRole("menuitem", { name: "Appearance" }))
    await userEvent.click(
      await screen.findByRole("menuitemradio", { name: /^Dark$/ })
    )
    await expect(canvas.getByRole("status")).toHaveTextContent("Theme: dark")
  },
}
export const MenuFailureAndRetry: Story = {
  render: () => <MenuExample scenario="error" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      screen = within(canvasElement.ownerDocument.body)
    const trigger = canvas.getByRole("button", { name: "Skill actions" })
    await waitFor(() => expect(trigger).toBeEnabled())
    await userEvent.click(trigger)
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /^Archive$/ })
    )
    await expect(await canvas.findByText("Couldn’t save")).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }))
    await expect(
      await canvas.findByText("Saved in this simulation.")
    ).toBeVisible()
  },
}

export const TooltipAndIconAction: Story = {
  render: () => (
    <div className="flex min-h-40 items-center gap-5">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label="More skill actions"
              />
            }
          >
            <MoreHorizontalIcon />
          </TooltipTrigger>
          <TooltipContent>More skill actions</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" />}>
            Connection status
          </TooltipTrigger>
          <TooltipContent>
            Connected services are available for assistant tools.
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      screen = within(canvasElement.ownerDocument.body)
    canvas.getByRole("button", { name: "More skill actions" }).focus()
    await expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "More skill actions"
    )
    await userEvent.keyboard("{Escape}")
    await waitFor(() =>
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
    )
  },
}

export const SemanticTable: Story = {
  render: () => (
    <div className="max-w-[42rem]">
      <CardFrame>
        <CardFrameHeader>
          <CardFrameTitle>Connections</CardFrameTitle>
        </CardFrameHeader>
        <CardPanel>
          <Table
            containerProps={{
              role: "region",
              "aria-label": "Connection table",
              tabIndex: 0,
            }}
          >
            <TableCaption>
              Illustrative connection statuses. No live accounts.
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Service</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Tools</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableHead scope="row">ChatGPT</TableHead>
                <TableCell>
                  <Status>
                    <CheckIcon aria-hidden="true" />
                    Connected
                  </Status>
                </TableCell>
                <TableCell className="text-right tabular-nums">4</TableCell>
              </TableRow>
              <TableRow>
                <TableHead scope="row">Executor</TableHead>
                <TableCell>
                  <Status tone="warning">Unconfirmed</Status>
                </TableCell>
                <TableCell className="text-right tabular-nums">12</TableCell>
              </TableRow>
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableHead scope="row" colSpan={2}>
                  Supported tools
                </TableHead>
                <TableCell className="text-right tabular-nums">16</TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </CardPanel>
      </CardFrame>
    </div>
  ),
}

function LongExample() {
  const [notice, setNotice] = useState("")
  return (
    <div className="flex w-80 max-w-full flex-col gap-6">
      <CardFrame>
        <CardFrameHeader>
          <CardFrameTitle>
            Connections for household plans and everyday administration
          </CardFrameTitle>
          <CardFrameDescription>
            Titles and supporting text wrap without hiding the action.
          </CardFrameDescription>
          <CardFrameAction>
            <Button
              variant="outline"
              onClick={() => setNotice("Manage connection selected.")}
            >
              Manage connection
            </Button>
          </CardFrameAction>
        </CardFrameHeader>
        <CardPanel>
          <ItemGroup aria-label="Long content">
            <Item>
              <ItemMedia>
                <FileIcon aria-hidden="true" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  family-plans-and-everyday-administration-with-a-deliberately-long-unbroken-filename.md
                </ItemTitle>
                <ItemDescription>
                  The row grows with its content.
                </ItemDescription>
              </ItemContent>
            </Item>
          </ItemGroup>
        </CardPanel>
        <CardFrameFooter role="status">
          {notice || "Full values remain available."}
        </CardFrameFooter>
      </CardFrame>
      <Product />
    </div>
  )
}
export const LongContentAndNarrow: Story = { render: () => <LongExample /> }
