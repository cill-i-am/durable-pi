import type { Meta, StoryObj } from "@storybook/react-vite"
import { Button } from "@workspace/ui/components/button"

const meta = {
  title: "Foundations/System",
  parameters: { layout: "padded" },
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>
const roles = [
  ["24", "Price or metric", "text-xl font-semibold"],
  ["20", "Page title", "text-lg font-semibold"],
  ["18", "Drawer title", "text-sheet font-semibold"],
  ["16", "Group title", "text-md font-semibold"],
  ["16", "Editable value · mobile", "text-md"],
  ["14", "Control label / desktop value", "text-base"],
  ["13", "Supporting text", "text-sm"],
] as const
const colors = [
  "background",
  "canvas",
  "foreground",
  "muted-foreground",
  "card",
  "surface-underlay",
  "primary",
  "accent",
  "border",
  "input",
  "ring",
  "destructive",
  "warning",
] as const

export const Tokens: Story = {
  render: () => (
    <main className="flex max-w-6xl flex-col gap-10">
      <h1 className="text-lg font-semibold">Type, colour & geometry</h1>
      <div className="grid gap-10 md:grid-cols-2">
        <section className="flex flex-col gap-5" aria-label="Type roles">
          <h2 className="text-md font-semibold">Type</h2>
          {roles.map(([size, label, className]) => (
            <div key={label} className="flex items-baseline gap-6">
              <span className="w-6 shrink-0 text-sm text-muted-foreground">
                {size}
              </span>
              <span className={className}>{label}</span>
            </div>
          ))}
        </section>
        <section className="flex flex-col gap-5">
          <h2 className="text-md font-semibold">Geometry</h2>
          <div className="flex flex-wrap gap-5">
            {[
              [6, "Segment"],
              [10, "Control"],
              [14, "Compact frame"],

              [24, "Sheet"],
            ].map(([radius, label]) => (
              <div key={label} className="flex flex-col items-center gap-2">
                <div
                  className="size-16 border border-border bg-card shadow-(--shadow-card)"
                  style={{ borderRadius: Number(radius) }}
                />
                <span className="text-sm">{label}</span>
                <span className="text-sm text-muted-foreground">
                  {radius} px
                </span>
              </div>
            ))}
          </div>
          <h2 className="text-md font-semibold">Spacing</h2>
          <div className="flex flex-wrap gap-5">
            {[4, 8, 12, 16, 20, 24, 32, 40].map((size) => (
              <div key={size} className="flex flex-col items-center gap-2">
                <div
                  className="h-4 rounded-sm bg-primary"
                  style={{ width: size }}
                />
                <span className="text-sm text-muted-foreground">{size}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
      <section className="flex flex-col gap-5">
        <h2 className="text-md font-semibold">Semantic colours</h2>
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-5">
          {colors.map((role) => (
            <div key={role} className="flex flex-col gap-2">
              <div
                className="h-16 rounded-md border border-border"
                style={{ backgroundColor: "var(--" + role + ")" }}
              />
              <span className="text-sm">{role}</span>
            </div>
          ))}
        </div>
      </section>
      <section className="flex flex-col gap-5">
        <h2 className="text-md font-semibold">Material</h2>
        <div className="flex flex-wrap gap-4">
          <Button>Save</Button>
          <Button variant="outline">Connect</Button>
          <Button variant="secondary">Refresh</Button>
          <Button variant="destructive">Remove</Button>
          <Button variant="ghost">Copy link</Button>
        </div>
      </section>
    </main>
  ),
}
