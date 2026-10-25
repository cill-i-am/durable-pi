import { Button } from "@workspace/ui/components/button"
import { Checkbox } from "@workspace/ui/components/checkbox"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Spinner } from "@workspace/ui/components/spinner"
import { Switch } from "@workspace/ui/components/switch"
import { Textarea } from "@workspace/ui/components/textarea"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@workspace/ui/components/toggle-group"
import { MoreHorizontalIcon, PlusIcon } from "lucide-react"
import { useId, useState } from "react"

import { useLab } from "../state/use-lab"

const roles = [
  {
    key: "primary",
    name: "Primary",
    variant: "default",
    label: "Save",
    working: "Saving…",
  },
  {
    key: "outline",
    name: "Outline",
    variant: "outline",
    label: "Connect",
    working: "Connecting…",
  },
  {
    key: "secondary",
    name: "Secondary",
    variant: "secondary",
    label: "Refresh",
    working: "Refreshing…",
  },
  {
    key: "destructive",
    name: "Destructive",
    variant: "destructive",
    label: "Remove",
    working: "Removing…",
  },
  {
    key: "ghost",
    name: "Ghost",
    variant: "ghost",
    label: "Copy link",
    working: "Copying…",
  },
  {
    key: "icon",
    name: "Icon",
    variant: "ghost",
    label: "More options",
    working: "Loading options",
  },
  {
    key: "link",
    name: "Link",
    variant: "link",
    label: "View history",
    working: "Opening history…",
  },
] as const

const states = [
  "Default",
  "Hover",
  "Pressed",
  "Focus",
  "Disabled",
  "Working",
] as const

const buttonPseudo = {
  hover: roles.map((role) => `#${role.key}-hover`),
  active: roles.map((role) => `#${role.key}-pressed`),
  focus: roles.map((role) => `#${role.key}-focus`),
  focusVisible: roles.map((role) => `#${role.key}-focus`),
}

const models = [
  { value: "sol", label: "GPT-6.1 Sol" },
  { value: "astra", label: "GPT-6 Astra" },
  { value: "luna", label: "GPT-6 Luna" },
]

export function ActionDemo({
  scenario,
}: {
  scenario: "success" | "error" | "uncertain" | "hold"
}) {
  const lab = useLab({ scenario, identity: `save-${scenario}` })
  return (
    <div className="flex max-w-md flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {(lab.status === "idle" || lab.status === "error" || lab.busy) && (
          <Button
            {...lab.interactionProps}
            disabled={lab.disabled}
            aria-busy={lab.busy || undefined}
            onClick={lab.status === "error" ? lab.retry : lab.start}
          >
            {lab.busy && <Spinner data-icon="inline-start" />}
            {lab.busy
              ? "Saving…"
              : lab.status === "error"
                ? "Try again"
                : "Save default"}
          </Button>
        )}
        {lab.busy && (
          <Button variant="outline" onClick={lab.cancel}>
            Cancel
          </Button>
        )}
        {lab.status === "uncertain" && (
          <Button variant="outline" onClick={lab.check}>
            Check status
          </Button>
        )}
        {!lab.busy && lab.status !== "idle" && (
          <Button variant="ghost" onClick={lab.reset}>
            Reset example
          </Button>
        )}
      </div>
      {lab.status === "success" && (
        <p role="status" className="text-sm leading-5 text-muted-foreground">
          Default saved.
        </p>
      )}
      {lab.status === "error" && (
        <FieldError>Couldn’t save. Try again.</FieldError>
      )}
      {lab.status === "uncertain" && (
        <p role="status" className="text-sm leading-5 text-muted-foreground">
          Save not confirmed. Check its status before trying again.
        </p>
      )}
      {lab.status === "cancelled" && (
        <p role="status" className="text-sm leading-5 text-muted-foreground">
          Save cancelled.
        </p>
      )}
    </div>
  )
}

export function FieldExample({
  state,
  kind,
}: {
  state: "Default" | "Focus" | "Error" | "Disabled"
  kind: "input" | "select" | "textarea"
}) {
  const id = `${kind}-${state.toLowerCase()}`
  const invalid = state === "Error"
  const disabled = state === "Disabled"
  const label =
    kind === "input" ? "Name" : kind === "select" ? "Skill" : "Instructions"
  const error =
    kind === "input"
      ? "Enter a name."
      : kind === "select"
        ? "Choose a skill."
        : "Enter instructions."
  return (
    <Field data-invalid={invalid} data-disabled={disabled}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {kind === "input" ? (
        <Input
          id={id}
          defaultValue={state === "Focus" || disabled ? "Weekly planning" : ""}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? `${id}-error` : undefined}
        />
      ) : kind === "textarea" ? (
        <Textarea
          id={id}
          defaultValue={
            invalid ? "" : "Use short sentences. Prefer plain language."
          }
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? `${id}-error` : undefined}
        />
      ) : (
        <Select
          disabled={disabled}
          defaultValue={state === "Focus" || disabled ? "planning" : null}
          items={{ planning: "Weekly planning", lists: "Shared lists" }}
        >
          <SelectTrigger
            id={id}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? `${id}-error` : undefined}
          >
            <SelectValue placeholder="Choose a skill" />
          </SelectTrigger>
          <SelectContent mobileTitle="Skill">
            <SelectGroup>
              <SelectItem value="planning">Weekly planning</SelectItem>
              <SelectItem value="lists">Shared lists</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      )}
      {invalid && <FieldError id={`${id}-error`}>{error}</FieldError>}
    </Field>
  )
}

export function SelectionDemo() {
  const id = useId()
  const [accepted, setAccepted] = useState(false)
  const [animations, setAnimations] = useState(true)
  const [theme, setTheme] = useState<string[]>(["system"])
  return (
    <div className="grid gap-10 sm:grid-cols-2 xl:grid-cols-3">
      <FieldSet>
        <FieldLegend>Checkboxes</FieldLegend>
        <FieldGroup>
          {[
            { key: "off", label: "Off" },
            { key: "on", label: "On", defaultChecked: true },
            { key: "mixed", label: "Indeterminate", indeterminate: true },
            {
              key: "disabled",
              label: "Disabled",
              defaultChecked: true,
              disabled: true,
            },
            { key: "invalid", label: "Required", invalid: true },
          ].map((item) => (
            <Field
              key={item.key}
              orientation="horizontal"
              data-disabled={item.disabled}
              data-invalid={item.invalid}
            >
              <Checkbox
                id={`${id}-${item.key}`}
                defaultChecked={item.defaultChecked}
                indeterminate={item.indeterminate}
                disabled={item.disabled}
                aria-invalid={item.invalid || undefined}
              />
              <FieldLabel htmlFor={`${id}-${item.key}`}>
                {item.label}
              </FieldLabel>
            </Field>
          ))}
          <Field orientation="horizontal">
            <Checkbox
              id={`${id}-controlled`}
              checked={accepted}
              onCheckedChange={setAccepted}
            />
            <FieldLabel htmlFor={`${id}-controlled`}>
              Allow notifications
            </FieldLabel>
          </Field>
        </FieldGroup>
      </FieldSet>
      <FieldSet>
        <FieldLegend>Switches</FieldLegend>
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldLabel htmlFor={`${id}-switch-off`}>Off</FieldLabel>
            <Switch id={`${id}-switch-off`} />
          </Field>
          <Field orientation="horizontal">
            <FieldLabel htmlFor={`${id}-switch-on`}>On</FieldLabel>
            <Switch id={`${id}-switch-on`} defaultChecked />
          </Field>
          <Field orientation="horizontal" data-disabled>
            <FieldLabel htmlFor={`${id}-switch-disabled`}>Disabled</FieldLabel>
            <Switch id={`${id}-switch-disabled`} defaultChecked disabled />
          </Field>
          <Field orientation="horizontal">
            <FieldLabel htmlFor={`${id}-animations`}>
              Activity animations
            </FieldLabel>
            <Switch
              id={`${id}-animations`}
              checked={animations}
              onCheckedChange={setAnimations}
            />
          </Field>
        </FieldGroup>
      </FieldSet>
      <FieldSet>
        <FieldLegend>Segments</FieldLegend>
        <FieldGroup>
          <Field>
            <FieldLabel>Theme</FieldLabel>
            <ToggleGroup
              aria-label="Theme"
              value={theme}
              onValueChange={(value) => {
                if (value.length) setTheme(value)
              }}
            >
              <ToggleGroupItem value="light">Light</ToggleGroupItem>
              <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
              <ToggleGroupItem value="system">System</ToggleGroupItem>
            </ToggleGroup>
          </Field>
          <Field>
            <FieldLabel>Tool access</FieldLabel>
            <ToggleGroup aria-label="Tool access" defaultValue={["ask"]}>
              <ToggleGroupItem value="allow">Allow</ToggleGroupItem>
              <ToggleGroupItem value="ask">Ask</ToggleGroupItem>
              <ToggleGroupItem value="deny">Deny</ToggleGroupItem>
            </ToggleGroup>
          </Field>
          <Field data-disabled>
            <FieldTitle>Disabled segments</FieldTitle>
            <ToggleGroup
              aria-label="Disabled segments"
              defaultValue={["ask"]}
              disabled
            >
              <ToggleGroupItem value="allow">Allow</ToggleGroupItem>
              <ToggleGroupItem value="ask">Ask</ToggleGroupItem>
              <ToggleGroupItem value="deny">Deny</ToggleGroupItem>
            </ToggleGroup>
          </Field>
        </FieldGroup>
      </FieldSet>
    </div>
  )
}

export function ModelSelect({
  defaultOpen = false,
  empty = false,
  loading = false,
  invalid = false,
  disabled = false,
}: {
  defaultOpen?: boolean
  empty?: boolean
  loading?: boolean
  invalid?: boolean
  disabled?: boolean
}) {
  const id = useId()
  return (
    <Field
      className="w-full max-w-sm"
      data-disabled={disabled || loading}
      data-invalid={invalid}
    >
      <FieldLabel htmlFor={id}>Model</FieldLabel>
      <Select
        items={empty || loading ? [] : models}
        defaultOpen={defaultOpen}
        disabled={disabled || loading}
      >
        <SelectTrigger
          id={id}
          aria-invalid={invalid || undefined}
          aria-busy={loading || undefined}
          aria-describedby={invalid ? `${id}-error` : undefined}
        >
          {loading && <Spinner />}
          <SelectValue
            placeholder={loading ? "Loading models…" : "Choose a model"}
          />
        </SelectTrigger>
        <SelectContent mobileTitle="Model">
          <SelectGroup>
            {empty || loading ? (
              <SelectItem
                value="no-options"
                disabled
                className="text-muted-foreground data-disabled:opacity-100"
              >
                {loading ? "Loading models…" : "No models available."}
              </SelectItem>
            ) : (
              <>
                <SelectLabel>Available models</SelectLabel>
                {models.map((model) => (
                  <SelectItem key={model.value} value={model.value}>
                    {model.label}
                  </SelectItem>
                ))}
                <SelectItem value="unavailable" disabled>
                  Unavailable model
                </SelectItem>
              </>
            )}
          </SelectGroup>
        </SelectContent>
      </Select>
      {invalid && <FieldError id={`${id}-error`}>Choose a model.</FieldError>}
    </Field>
  )
}

export function SelectRecoveryDemo() {
  const id = useId()
  const lab = useLab({ scenario: "success", identity: "model-options" })
  const available = lab.status === "success"
  const failed = lab.status === "idle" || lab.status === "error"
  return (
    <Field className="w-full max-w-sm" data-invalid={failed}>
      <FieldLabel htmlFor={id}>Model</FieldLabel>
      <Select items={available ? models : []} disabled={!available}>
        <SelectTrigger
          id={id}
          aria-invalid={failed || undefined}
          aria-busy={lab.busy || undefined}
          aria-describedby={failed ? `${id}-error` : undefined}
        >
          {lab.busy && <Spinner />}
          <SelectValue
            placeholder={lab.busy ? "Loading models…" : "Choose a model"}
          />
        </SelectTrigger>
        <SelectContent mobileTitle="Model">
          <SelectGroup>
            {models.map((model) => (
              <SelectItem key={model.value} value={model.value}>
                {model.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {failed && (
        <>
          <FieldError id={`${id}-error`}>
            Models couldn’t load. Try again.
          </FieldError>
          <Button
            variant="outline"
            onClick={lab.status === "idle" ? lab.start : lab.retry}
          >
            Try again
          </Button>
        </>
      )}
      {lab.busy && (
        <Button variant="ghost" onClick={lab.cancel}>
          Cancel
        </Button>
      )}
      {lab.status === "cancelled" && (
        <>
          <FieldDescription>Loading cancelled.</FieldDescription>
          <Button variant="outline" onClick={lab.reset}>
            Reset example
          </Button>
        </>
      )}
    </Field>
  )
}

export function EditableFieldsDemo() {
  const id = useId()
  const [name, setName] = useState("Weekly planning")
  const [instructions, setInstructions] = useState(
    "Use short sentences. Prefer plain language."
  )
  return (
    <FieldGroup className="max-w-md">
      <Field>
        <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
        <Input id={`${id}-name`} value={name} onValueChange={setName} />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-instructions`}>Instructions</FieldLabel>
        <Textarea
          id={`${id}-instructions`}
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
        />
        <FieldDescription>Used when this skill runs.</FieldDescription>
      </Field>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor={`${id}-enabled`}>Enabled</FieldLabel>
          <FieldDescription>Available to this assistant.</FieldDescription>
        </FieldContent>
        <Switch id={`${id}-enabled`} defaultChecked />
      </Field>
    </FieldGroup>
  )
}

export const ButtonStateMatrix = () => (
  <div
    role="region"
    aria-label="Button states"
    tabIndex={0}
    className="overflow-x-auto p-2"
  >
    <table className="w-full min-w-[1050px] border-separate border-spacing-x-3 border-spacing-y-4">
      <thead>
        <tr>
          <th className="text-left text-sm font-medium text-muted-foreground">
            Role
          </th>
          {states.map((state) => (
            <th
              key={state}
              className="text-sm font-medium text-muted-foreground"
            >
              {state}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {roles.map((role) => (
          <tr key={role.key}>
            <th
              scope="row"
              className="text-left text-sm font-medium text-muted-foreground"
            >
              {role.name}
            </th>
            {states.map((state) => (
              <td key={state} className="text-center">
                <Button
                  id={`${role.key}-${state.toLowerCase()}`}
                  variant={role.variant}
                  size={role.key === "icon" ? "icon" : "default"}
                  disabled={state === "Disabled" || state === "Working"}
                  aria-busy={state === "Working" || undefined}
                  aria-label={
                    role.key === "icon"
                      ? state === "Working"
                        ? role.working
                        : role.label
                      : undefined
                  }
                >
                  {state === "Working" ? (
                    <>
                      <Spinner data-icon="inline-start" />
                      {role.key !== "icon" && role.working}
                    </>
                  ) : role.key === "icon" ? (
                    <MoreHorizontalIcon />
                  ) : (
                    role.label
                  )}
                </Button>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
)

export const ButtonSizeMatrix = () => (
  <div className="flex flex-col gap-6">
    {roles
      .filter((role) => role.key !== "icon")
      .map((role) => (
        <section
          key={role.key}
          aria-label={`${role.name} sizes`}
          className="flex flex-wrap items-center gap-3"
        >
          <span className="w-24 text-sm text-muted-foreground">
            {role.name}
          </span>
          {(["sm", "default", "lg"] as const).map((size) => (
            <Button key={size} variant={role.variant} size={size}>
              {role.label}
            </Button>
          ))}
          {(["icon-sm", "icon", "icon-lg"] as const).map((size) => (
            <Button
              key={size}
              variant={role.variant}
              size={size}
              aria-label={`${role.label} (${size})`}
            >
              <PlusIcon />
            </Button>
          ))}
        </section>
      ))}
  </div>
)

export const FormFieldStates = () => (
  <div className="grid gap-8 sm:grid-cols-2 xl:grid-cols-4">
    {(["Default", "Focus", "Error", "Disabled"] as const).map((state) => (
      <section key={state} className="flex min-w-0 flex-col gap-6">
        <h2 className="text-md leading-6 font-semibold">{state}</h2>
        <FieldGroup>
          {(["input", "select", "textarea"] as const).map((kind) => (
            <FieldExample key={kind} state={state} kind={kind} />
          ))}
        </FieldGroup>
      </section>
    ))}
  </div>
)

export const buttonStateParameters = {
  pseudo: buttonPseudo,
  controls: { disable: true },
}

export const fieldStateParameters = {
  controls: { disable: true },
  pseudo: {
    focus: ["#input-focus", "#select-focus", "#textarea-focus"],
    focusVisible: ["#input-focus", "#select-focus", "#textarea-focus"],
  },
}
