import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { Switch } from "@workspace/ui/components/switch"
import { useId, type ComponentProps } from "react"

function Example(args: ComponentProps<typeof Field> & { invalid?: boolean }) {
  const id = useId()
  const { invalid = false, ...props } = args
  return (
    <Field {...props} data-invalid={invalid} className="w-full max-w-md">
      <FieldLabel htmlFor={id}>Name</FieldLabel>
      <Input
        id={id}
        defaultValue={invalid ? "" : "Weekly planning"}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${id}-error` : `${id}-description`}
      />
      {invalid ? (
        <FieldError id={`${id}-error`}>Enter a name.</FieldError>
      ) : (
        <FieldDescription id={`${id}-description`}>
          Shown in your skills.
        </FieldDescription>
      )}
    </Field>
  )
}
const meta = {
  title: "Components/Field",
  component: Field,
  subcomponents: {
    FieldContent,
    FieldDescription,
    FieldError,
    FieldGroup,
    FieldLabel,
    FieldLegend,
    FieldSeparator,
    FieldSet,
    FieldTitle,
  },
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: { orientation: "vertical" },
  argTypes: {
    orientation: {
      control: "select",
      options: ["vertical", "horizontal", "responsive"],
    },
  },
  render: (args) => <Example {...args} />,
} satisfies Meta<typeof Field>
export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
export const Invalid: Story = {
  render: (args) => <Example {...args} invalid />,
}
export const Horizontal: Story = {
  args: { orientation: "horizontal" },
  render: (args) => (
    <Field {...args} className="w-full max-w-md">
      <FieldContent>
        <FieldLabel htmlFor="field-horizontal-enabled">
          Activity animations
        </FieldLabel>
        <FieldDescription>On this device.</FieldDescription>
      </FieldContent>
      <Switch id="field-horizontal-enabled" defaultChecked />
    </Field>
  ),
}
export const Grouped: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <FieldSet className="max-w-md">
      <FieldLegend>Skill</FieldLegend>
      <FieldGroup>
        <Example orientation="vertical" />
        <FieldSeparator />
        <Field>
          <FieldTitle>Availability</FieldTitle>
          <FieldDescription>Available to this assistant.</FieldDescription>
        </Field>
      </FieldGroup>
    </FieldSet>
  ),
}
