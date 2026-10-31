import { Button } from "@workspace/ui/components/button"
import { Schema } from "effect"
import { useCallback, useId, useState } from "react"

import { AppId, Revision } from "@/apps/contracts"

import { AppView } from "./app-view"

const Reference = Schema.Struct({
  appId: AppId,
  title: Schema.String,
  publishedVersion: Revision,
})
type Props = {
  agentId: string
  output: string
  onPendingChange?: (key: string, pending: boolean) => void
}
export function InlineApp({ output, ...props }: Props) {
  let reference: typeof Reference.Type
  try {
    reference = Schema.decodeUnknownSync(Reference)(JSON.parse(output))
  } catch {
    return null
  }
  return (
    <InlineAppContent
      key={`${props.agentId}/${reference.appId}`}
      {...props}
      reference={reference}
    />
  )
}
function InlineAppContent({
  agentId,
  reference,
  onPendingChange,
}: Omit<Props, "output"> & { reference: typeof Reference.Type }) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const key = useId()
  const reportPending = useCallback(
    (value: boolean) => {
      setPending(value)
      onPendingChange?.(key, value)
    },
    [key, onPendingChange]
  )
  return (
    <section
      className="flex min-w-0 flex-col gap-4 rounded-lg border p-4"
      aria-label="App in conversation"
    >
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Hide app" : `Open ${reference.title}`}
      </Button>
      {open && (
        <AppView
          key={reference.appId}
          agentId={agentId}
          id={reference.appId}
          initialVersion={reference.publishedVersion}
          compact
          onPendingChange={reportPending}
        />
      )}
    </section>
  )
}
