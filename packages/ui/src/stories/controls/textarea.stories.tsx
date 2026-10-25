import type { Meta, StoryObj } from "@storybook/react-vite"
import { Field, FieldLabel, FieldError } from "@workspace/ui/components/field"
import { Textarea } from "@workspace/ui/components/textarea"
import { useId, type ComponentProps } from "react"
function Example(args: ComponentProps<typeof Textarea>) {
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
      <FieldLabel htmlFor={id}>Instructions</FieldLabel>
      <Textarea
        {...args}
        id={id}
        aria-describedby={invalid ? `${id}-error` : args["aria-describedby"]}
      />
      {invalid && (
        <FieldError id={`${id}-error`}>Enter instructions.</FieldError>
      )}
    </Field>
  )
}

const meta = {
  title: "Components/Textarea",
  component: Textarea,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    defaultValue: "Use short sentences. Prefer plain language.",
    disabled: false,
    readOnly: false,
    placeholder: "Instructions",
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
} satisfies Meta<typeof Textarea>
export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
export const Focus: Story = {
  parameters: {
    pseudo: {
      focus: ['[data-slot="textarea"]'],
      focusVisible: ['[data-slot="textarea"]'],
    },
  },
}
export const Invalid: Story = {
  args: { defaultValue: "", "aria-invalid": true, required: true },
}
export const Disabled: Story = { args: { disabled: true } }
export const ReadOnly: Story = { args: { readOnly: true } }
