import type { Meta, StoryObj } from "@storybook/react-vite"
import { Field, FieldLabel, FieldError } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { useId, type ComponentProps } from "react"
function Example(args: ComponentProps<typeof Input>) {
  const generated = useId()
  const id = args.id ?? generated
  const invalid =
    args["aria-invalid"] === true || args["aria-invalid"] === "true"
  return (
    <Field
      className="w-full max-w-sm"
      data-disabled={args.disabled}
      data-invalid={invalid}
    >
      <FieldLabel htmlFor={id}>Name</FieldLabel>
      <Input
        {...args}
        id={id}
        aria-describedby={invalid ? `${id}-error` : args["aria-describedby"]}
      />
      {invalid && <FieldError id={`${id}-error`}>Enter a name.</FieldError>}
    </Field>
  )
}

const meta = {
  title: "Components/Input",
  component: Input,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    defaultValue: "Weekly planning",
    disabled: false,
    readOnly: false,
    placeholder: "Name",
  },
  argTypes: {
    defaultValue: { control: "text" },
    placeholder: { control: "text" },
    disabled: { control: "boolean" },
    readOnly: { control: "boolean" },
    required: { control: "boolean" },
    "aria-invalid": { control: "boolean" },
  },
  render: (args) => <Example {...args} />,
} satisfies Meta<typeof Input>
export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
export const Focus: Story = {
  parameters: {
    pseudo: {
      focus: ['[data-slot="input"]'],
      focusVisible: ['[data-slot="input"]'],
    },
  },
}
export const Invalid: Story = {
  args: { defaultValue: "", "aria-invalid": true, required: true },
}
export const Disabled: Story = { args: { disabled: true } }
export const ReadOnly: Story = { args: { readOnly: true } }
