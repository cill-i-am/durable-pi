import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"

const rows = (
  <>
    <TableRow>
      <TableHead scope="row">Weekly planning</TableHead>
      <TableCell>Today</TableCell>
      <TableCell className="text-right tabular-nums">2</TableCell>
    </TableRow>
    <TableRow>
      <TableHead scope="row">Meal planning</TableHead>
      <TableCell>Yesterday</TableCell>
      <TableCell className="text-right tabular-nums">3</TableCell>
    </TableRow>
  </>
)
const heading = (
  <TableHeader>
    <TableRow>
      <TableHead>Skill</TableHead>
      <TableHead>Updated</TableHead>
      <TableHead className="text-right">Version</TableHead>
    </TableRow>
  </TableHeader>
)
const meta = {
  title: "Components/Table",
  component: Table,
  subcomponents: {
    TableHeader,
    TableBody,
    TableFooter,
    TableRow,
    TableHead,
    TableCell,
    TableCaption,
  },
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    className: "min-w-96",
    containerProps: {
      className: "max-w-2xl",
      role: "region",
      "aria-label": "Skills table",
      tabIndex: 0,
    },
    children: (
      <>
        <TableCaption>Illustrative skills and versions.</TableCaption>
        {heading}
        <TableBody>{rows}</TableBody>
      </>
    ),
  },
  argTypes: {
    children: { control: false },
    className: { control: "text" },
    containerProps: { control: "object" },
  },
} satisfies Meta<typeof Table>
export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const Playground: Story = {
  args: {
    containerProps: {
      className: "w-80 max-w-full",
      role: "region",
      "aria-label": "Scrollable skills table",
      tabIndex: 0,
    },
  },
}
export const WithFooter: Story = {
  args: {
    children: (
      <>
        <TableCaption>Illustrative skills and versions.</TableCaption>
        {heading}
        <TableBody>{rows}</TableBody>
        <TableFooter>
          <TableRow>
            <TableHead scope="row" colSpan={2}>
              Skills
            </TableHead>
            <TableCell className="text-right tabular-nums">2</TableCell>
          </TableRow>
        </TableFooter>
      </>
    ),
  },
}
export const Empty: Story = {
  args: {
    children: (
      <>
        <TableCaption>Skills and versions.</TableCaption>
        {heading}
        <TableBody>
          <TableRow>
            <TableCell
              colSpan={3}
              className="text-center text-muted-foreground"
            >
              No skills yet.
            </TableCell>
          </TableRow>
        </TableBody>
      </>
    ),
  },
}
export const SelectedRow: Story = {
  args: {
    children: (
      <>
        <TableCaption>Illustrative selected row.</TableCaption>
        {heading}
        <TableBody>
          <TableRow data-state="selected">
            <TableHead scope="row">Weekly planning</TableHead>
            <TableCell>Today</TableCell>
            <TableCell className="text-right tabular-nums">2</TableCell>
          </TableRow>
        </TableBody>
      </>
    ),
  },
}
