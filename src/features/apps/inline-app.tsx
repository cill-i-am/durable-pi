import { useState } from "react"
import { Schema } from "effect"
import { AppId, Revision } from "@/apps/contracts"
import { Button } from "@/components/ui/button"
import { AppView } from "./app-view"

const Reference = Schema.Struct({
  appId: AppId,
  title: Schema.String,
  publishedVersion: Revision,
})
export function InlineApp({
  agentId,
  output,
}: {
  agentId: string
  output: string
}) {
  const [open, setOpen] = useState(false)
  let reference: typeof Reference.Type
  try {
    reference = Schema.decodeUnknownSync(Reference)(JSON.parse(output))
  } catch {
    return null
  }
  return (
    <section
      className="flex min-w-0 flex-col gap-4 rounded-lg border p-4"
      aria-label="App in conversation"
    >
      <Button
        variant="outline"
        size="sm"
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
        />
      )}
    </section>
  )
}
