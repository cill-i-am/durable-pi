import type { Meta, StoryObj } from "@storybook/react-vite"
import { Checkbox } from "@workspace/ui/components/checkbox"
import { Field, FieldLabel, FieldError } from "@workspace/ui/components/field"
import { useId, useState, type ComponentProps } from "react"

function Example(args: ComponentProps<typeof Checkbox>) {
  const generated = useId()
  const id = args.id ?? generated
  const invalid =
    args["aria-invalid"] === true || args["aria-invalid"] === "true"
  return (
    <div className="flex max-w-sm flex-col gap-2">
      <Field
        orientation="horizontal"
        data-disabled={args.disabled}
        data-invalid={invalid}
      >
        <Checkbox
          {...args}
          id={id}
          aria-describedby={invalid ? `${id}-error` : args["aria-describedby"]}
        />
        <FieldLabel htmlFor={id}>Allow notifications</FieldLabel>
      </Field>
      {invalid && (
        <FieldError id={`${id}-error`}>
          Choose whether to allow notifications.
        </FieldError>
      )}
    </div>
  )
}
function ControlledExample() {
  const [checked, setChecked] = useState(false)
  return <Example checked={checked} onCheckedChange={setChecked} />
}
const meta = {
  title: "Components/Checkbox",
  component: Checkbox,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: { defaultChecked: false, disabled: false, indeterminate: false },
  argTypes: {
    defaultChecked: { control: "boolean" },
    disabled: { control: "boolean" },
    indeterminate: { control: "boolean" },
    required: { control: "boolean" },
    "aria-invalid": { control: "boolean" },
  },
  render: (args) => <Example {...args} />,
} satisfies Meta<typeof Checkbox>
export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
export const Checked: Story = { args: { defaultChecked: true } }
export const Indeterminate: Story = { args: { indeterminate: true } }
export const Focus: Story = {
  parameters: {
    pseudo: {
      focus: ['[data-slot="checkbox"]'],
      focusVisible: ['[data-slot="checkbox"]'],
    },
  },
}
export const Disabled: Story = {
  args: { defaultChecked: true, disabled: true },
}
export const Invalid: Story = { args: { "aria-invalid": true } }
export const Controlled: Story = {
  parameters: { controls: { disable: true } },
  render: () => <ControlledExample />,
}
