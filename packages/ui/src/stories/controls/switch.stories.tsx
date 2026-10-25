import type { Meta, StoryObj } from "@storybook/react-vite"
import { Field, FieldLabel, FieldError } from "@workspace/ui/components/field"
import { Switch } from "@workspace/ui/components/switch"
import { useId, useState, type ComponentProps } from "react"

function Example(args: ComponentProps<typeof Switch>) {
  const generated = useId()
  const id = args.id ?? generated
  const invalid =
    args["aria-invalid"] === true || args["aria-invalid"] === "true"
  return (
    <div className="flex w-full max-w-sm flex-col gap-2">
      <Field
        orientation="horizontal"
        data-disabled={args.disabled}
        data-invalid={invalid}
      >
        <FieldLabel htmlFor={id}>Activity animations</FieldLabel>
        <Switch
          {...args}
          id={id}
          aria-describedby={invalid ? `${id}-error` : args["aria-describedby"]}
        />
      </Field>
      {invalid && (
        <FieldError id={`${id}-error`}>
          Choose whether animations are enabled.
        </FieldError>
      )}
    </div>
  )
}
function ControlledExample() {
  const [checked, setChecked] = useState(true)
  return <Example checked={checked} onCheckedChange={setChecked} />
}
const meta = {
  title: "Components/Switch",
  component: Switch,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: { defaultChecked: true, disabled: false },
  argTypes: {
    defaultChecked: { control: "boolean" },
    disabled: { control: "boolean" },
    "aria-invalid": { control: "boolean" },
  },
  render: (args) => <Example {...args} />,
} satisfies Meta<typeof Switch>
export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
export const Off: Story = { args: { defaultChecked: false } }
export const Focus: Story = {
  parameters: {
    pseudo: {
      focus: ['[data-slot="switch"]'],
      focusVisible: ['[data-slot="switch"]'],
    },
  },
}
export const Disabled: Story = { args: { disabled: true } }
export const Invalid: Story = { args: { "aria-invalid": true } }
export const Controlled: Story = {
  parameters: { controls: { disable: true } },
  render: () => <ControlledExample />,
}

function RapidExample() {
  const [checked, setChecked] = useState(false)
  return (
    <div className="flex max-w-sm flex-col gap-2">
      <Example checked={checked} onCheckedChange={setChecked} />
      <p role="status" className="text-sm text-muted-foreground">
        {checked ? "On" : "Off"}
      </p>
    </div>
  )
}

export const MotionRapid: Story = {
  parameters: { controls: { disable: true } },
  render: () => <RapidExample />,
}
