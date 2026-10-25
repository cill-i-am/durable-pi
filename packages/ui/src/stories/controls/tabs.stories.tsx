import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@workspace/ui/components/tabs"
import { expect, userEvent, within } from "storybook/test"
const meta = {
  title: "Components/Tabs",
  component: Tabs,
  subcomponents: { TabsList, TabsTrigger, TabsContent },
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: { defaultValue: "active", orientation: "horizontal" },
  argTypes: {
    defaultValue: { control: "select", options: ["active", "archived"] },
    orientation: { control: "select", options: ["horizontal", "vertical"] },
  },
  render: (args) => (
    <Tabs {...args} className="max-w-md">
      <TabsList aria-label="Skills">
        <TabsTrigger value="active">Active</TabsTrigger>
        <TabsTrigger value="archived">Archived</TabsTrigger>
        <TabsTrigger value="disabled" disabled>
          Unavailable
        </TabsTrigger>
      </TabsList>
      <TabsContent value="active">Weekly planning</TabsContent>
      <TabsContent value="archived">No archived skills.</TabsContent>
    </Tabs>
  ),
} satisfies Meta<typeof Tabs>
export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("tab", { name: "Archived" }))
    await expect(
      canvas.getByRole("tabpanel", { name: "Archived" })
    ).toHaveTextContent("No archived skills.")
    await expect(
      canvas.getByRole("tab", { name: "Unavailable" })
    ).toBeDisabled()
  },
}
export const Focus: Story = {
  parameters: {
    pseudo: {
      focus: ['[data-slot="tabs-trigger"][aria-selected="true"]'],
      focusVisible: ['[data-slot="tabs-trigger"][aria-selected="true"]'],
    },
  },
}
export const Vertical: Story = { args: { orientation: "vertical" } }
