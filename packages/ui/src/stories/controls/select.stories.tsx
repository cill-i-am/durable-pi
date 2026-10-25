import type { Meta, StoryObj } from "@storybook/react-vite"
import { Field, FieldLabel } from "@workspace/ui/components/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { useId, type ComponentProps } from "react"

import { ModelSelect, SelectRecoveryDemo } from "./fixtures"

const models = [
  { value: "sol", label: "GPT-6.1 Sol" },
  { value: "astra", label: "GPT-6 Astra" },
  { value: "luna", label: "GPT-6 Luna" },
]
function Example(args: ComponentProps<typeof Select>) {
  const id = useId()
  return (
    <Field className="w-full max-w-sm" data-disabled={args.disabled}>
      <FieldLabel htmlFor={id}>Model</FieldLabel>
      <Select {...args} items={models}>
        <SelectTrigger id={id}>
          <SelectValue placeholder="Choose a model" />
        </SelectTrigger>
        <SelectContent mobileTitle="Model">
          <SelectGroup>
            <SelectLabel>Available models</SelectLabel>
            {models.map((model) => (
              <SelectItem key={model.value} value={model.value}>
                {model.label}
              </SelectItem>
            ))}
            <SelectItem value="unavailable" disabled>
              Unavailable model
            </SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  )
}
const meta = {
  title: "Components/Select",
  component: Select,
  subcomponents: {
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    SelectValue,
  },
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    defaultValue: null,
    defaultOpen: false,
    disabled: false,
    readOnly: false,
    required: false,
  },
  argTypes: {
    defaultValue: {
      control: "select",
      options: [null, "sol", "astra", "luna"],
    },
    defaultOpen: { control: "boolean" },
    disabled: { control: "boolean" },
    readOnly: { control: "boolean" },
    required: { control: "boolean" },
  },
  render: (args) => <Example {...args} />,
} satisfies Meta<typeof Select>
export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
export const Open: Story = { args: { defaultOpen: true } }
export const Focus: Story = {
  parameters: {
    pseudo: {
      focus: ['[data-slot="select-trigger"]'],
      focusVisible: ['[data-slot="select-trigger"]'],
    },
  },
}
export const Empty: Story = {
  parameters: { controls: { disable: true } },
  render: () => <ModelSelect defaultOpen empty />,
}
export const Loading: Story = {
  parameters: { controls: { disable: true } },
  render: () => <ModelSelect loading />,
}
export const Invalid: Story = {
  parameters: { controls: { disable: true } },
  render: () => <ModelSelect invalid />,
}
export const Disabled: Story = { args: { disabled: true } }
export const ReadOnly: Story = { args: { defaultValue: "sol", readOnly: true } }
export const ErrorRecovery: Story = {
  parameters: { controls: { disable: true } },
  render: () => <SelectRecoveryDemo />,
}
