import type { Meta, StoryObj } from "@storybook/react-vite"

import {
  EditableFieldsDemo,
  SelectionDemo,
  FormFieldStates,
  fieldStateParameters,
} from "../controls/fixtures"
const meta = {
  title: "Compositions/Forms",
  tags: ["autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>
export const EditableFields: Story = { render: () => <EditableFieldsDemo /> }
export const SelectionControls: Story = { render: () => <SelectionDemo /> }
export const FieldStates: Story = {
  parameters: fieldStateParameters,
  render: () => <FormFieldStates />,
}
