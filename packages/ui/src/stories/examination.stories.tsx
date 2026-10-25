import type { Meta, StoryObj } from "@storybook/react-vite"
import { Button } from "@workspace/ui/components/button"
import { Field, FieldLabel } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { useId, useState } from "react"

import { labStates, labEdges } from "./state/lab.machine"
import { useLab } from "./state/use-lab"

const meta = {
  title: "Examination/Lifecycle",
  component: LifecycleExplorer,
  parameters: { layout: "padded" },
  args: { scenario: "success", delayMs: 1400 },
  argTypes: {
    scenario: {
      control: "select",
      options: ["success", "error", "uncertain", "hold"],
    },
    delayMs: { control: { type: "range", min: 200, max: 8000, step: 200 } },
  },
} satisfies Meta<typeof LifecycleExplorer>
export default meta
type Story = StoryObj<typeof meta>

function ExplorerActions({ lab }: { lab: ReturnType<typeof useLab> }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="submit"
        {...lab.interactionProps}
        disabled={!lab.ready || lab.disabled || lab.status !== "idle"}
        aria-busy={lab.busy || undefined}
      >
        {lab.busy
          ? lab.snapshot?.context.mode === "check"
            ? "Checking…"
            : "Saving…"
          : "Save changes"}
      </Button>
      {lab.busy && (
        <Button type="button" variant="outline" onClick={lab.cancel}>
          Cancel
        </Button>
      )}
      {lab.status === "error" && (
        <Button type="button" variant="outline" onClick={lab.retry}>
          Try again
        </Button>
      )}
      {lab.status === "uncertain" && (
        <Button type="button" variant="outline" onClick={lab.check}>
          Check result
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        disabled={!lab.ready}
        onClick={lab.reset}
      >
        Reset
      </Button>
    </div>
  )
}
function outcomeText(lab: ReturnType<typeof useLab>) {
  switch (lab.status) {
    case "success":
      return "Saved."
    case "error":
      return lab.error
    case "uncertain":
      return "Save not confirmed. Check the existing request before trying again."
    case "cancelled":
      return "Cancelled."
    case "loading":
      return lab.snapshot?.context.mode === "check"
        ? "Checking the existing request…"
        : "Saving changes…"
    default:
      return "Ready."
  }
}

function LifecycleExplorer({
  scenario,
  delayMs,
}: {
  scenario: "success" | "error" | "uncertain" | "hold"
  delayMs: number
}) {
  const lab = useLab({ scenario, delayMs })
  const id = useId()
  const [draft, setDraft] = useState("Weekly planning")
  return (
    <div className="flex max-w-4xl flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold">State explorer</h1>
        <p className="max-w-2xl text-base text-muted-foreground">
          Choose an outcome in Controls, then save. Work and responses are
          simulated locally. Hover, press and keyboard focus remain separate
          from the operation outcome.
        </p>
      </div>
      <div className="grid gap-8 md:grid-cols-2">
        <form
          className="flex flex-col gap-5 rounded-md border border-border bg-card p-5 shadow-(--shadow-card)"
          onSubmit={(event) => {
            event.preventDefault()
            lab.start()
          }}
        >
          <Field>
            <FieldLabel htmlFor={id}>Name</FieldLabel>
            <Input
              id={id}
              required
              value={draft}
              onValueChange={setDraft}
              readOnly={lab.busy}
            />
          </Field>
          <ExplorerActions lab={lab} />
          <div role="status" aria-live="polite" className="min-h-6 text-base">
            {outcomeText(lab)}
          </div>
        </form>
        <section
          className="flex flex-col gap-3"
          aria-label="Live machine state"
        >
          <h2 className="text-md font-semibold">Live state</h2>
          <Button
            type="button"
            variant="outline"
            disabled={!lab.ready || lab.busy}
            onClick={() =>
              lab.send({
                type:
                  lab.snapshot?.context.availability === "disabled"
                    ? "ENABLE"
                    : "DISABLE",
              })
            }
          >
            {lab.snapshot?.context.availability === "disabled"
              ? "Enable control"
              : "Disable control"}
          </Button>
          <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-base">
            <dt className="text-muted-foreground">Availability</dt>
            <dd>{lab.snapshot?.context.availability ?? "starting"}</dd>
            <dt className="text-muted-foreground">Operation</dt>
            <dd data-testid="lab-state">{lab.status}</dd>
            <dt className="text-muted-foreground">Pointer</dt>
            <dd>
              {lab.pressed ? "pressed" : lab.hovered ? "hovered" : "idle"}
            </dd>
            <dt className="text-muted-foreground">Focus</dt>
            <dd>{lab.focused ? "focused" : "blurred"}</dd>
            <dt className="text-muted-foreground">Attempt</dt>
            <dd className="font-mono text-sm break-all">
              {lab.attempt ? JSON.stringify(lab.attempt) : "None"}
            </dd>
            <dt className="text-muted-foreground">Receipt</dt>
            <dd className="font-mono text-sm break-all">
              {lab.receipt || "None"}
            </dd>
          </dl>
          <p className="text-sm text-muted-foreground">
            Reset, cancellation and unmount interrupt owned work and join
            cleanup. An uncertain result can be checked without resending.
          </p>
        </section>
      </div>
      <section className="flex flex-col gap-3" aria-label="State coverage">
        <h2 className="text-md font-semibold">Modeled behavior</h2>
        <p className="text-base text-muted-foreground">
          States and legal transitions come from the machine used by the
          examples. Unit tests execute every declared operation state and edge,
          including held cleanup and late results.
        </p>
        <div className="overflow-auto rounded-md border border-border bg-card p-4">
          <pre className="font-mono text-sm whitespace-pre-wrap">
            {JSON.stringify(
              { states: labStates, transitions: labEdges },
              null,
              2
            )}
          </pre>
        </div>
      </section>
    </div>
  )
}

export const Explorer: Story = {
  render: (args) => <LifecycleExplorer {...args} />,
}
export const KnownFailure: Story = {
  args: { scenario: "error" },
  render: (args) => <LifecycleExplorer {...args} />,
}
export const LostAcknowledgement: Story = {
  args: { scenario: "uncertain" },
  render: (args) => <LifecycleExplorer {...args} />,
}
export const HoldAndCancel: Story = {
  args: { scenario: "hold" },
  render: (args) => <LifecycleExplorer {...args} />,
}
