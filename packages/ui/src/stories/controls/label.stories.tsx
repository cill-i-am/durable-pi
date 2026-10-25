import type { Meta, StoryObj } from "@storybook/react-vite"
import { Checkbox } from "@workspace/ui/components/checkbox"
import { Field } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { useId, type ComponentProps } from "react"
function Example({
  inputDisabled = false,
  ...args
}: ComponentProps<typeof Label> & { inputDisabled?: boolean }) {
  const generated = useId()
  const id = args.htmlFor ?? generated
  return (
    <Field className="w-full max-w-sm" data-disabled={inputDisabled}>
      <Label {...args} htmlFor={id} />
      <Input id={id} defaultValue="Weekly planning" disabled={inputDisabled} />
    </Field>
  )
}
const meta = {
  title: "Components/Label",
  component: Label,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: { children: "Name" },
  argTypes: { children: { control: "text" }, htmlFor: { control: "text" } },
  render: (args) => <Example {...args} />,
} satisfies Meta<typeof Label>
export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
export const Disabled: Story = {
  render: (args) => <Example {...args} inputDisabled />,
}
export const WithCheckbox: Story = {
  args: { children: "Allow notifications", htmlFor: "label-checkbox-example" },
  render: (args) => (
    <Field orientation="horizontal" className="max-w-sm">
      <Checkbox id={args.htmlFor} />
      <Label {...args} />
    </Field>
  ),
}
