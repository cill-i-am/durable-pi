import { Schema } from "effect"
import { useEffect, useRef, useState } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import type { Group } from "@/delegation/contracts"
import { agentApi } from "@/http/client"

import { confirmedRejection } from "./delegation-commands"

const Command = Schema.Struct({
  groupId: Schema.Number,
  operationId: Schema.String,
  action: Schema.Literals(["stop", "retry"]),
})
export function BackgroundActions({
  agentId,
  group,
}: {
  agentId: string
  group: Group
}) {
  return (
    <div className="mt-3 flex flex-col gap-2">
      {group.background?.error && (
        <Alert>
          <AlertDescription>{group.background.error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <BackgroundAction
          agentId={agentId}
          group={group}
          action="stop"
          active={
            !!group.background &&
            !["delivered", "cancelled"].includes(group.background.delivery)
          }
        />
        <BackgroundAction
          agentId={agentId}
          group={group}
          action="retry"
          active={group.background?.delivery === "paused"}
        />
      </div>
    </div>
  )
}
function BackgroundAction({
  agentId,
  group,
  action,
  active,
}: {
  agentId: string
  group: Group
  action: "stop" | "retry"
  active: boolean
}) {
  const key = `background-command:${agentId}:${group.id}:${action}`
  const [saved, setSaved] = useState<typeof Command.Type | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("")
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    try {
      const value = sessionStorage.getItem(key)
      setSaved(
        value ? Schema.decodeUnknownSync(Command)(JSON.parse(value)) : null
      )
    } catch {
      setSaved(null)
    }
    return () => {
      mounted.current = false
    }
  }, [key])
  async function submit() {
    if (busy || (!saved && !active)) return
    setBusy(true)
    setError("")
    const input = saved ?? {
      groupId: group.id,
      operationId: crypto.randomUUID(),
      action,
    }
    const clear = () => {
      const value = sessionStorage.getItem(key)
      if (
        value &&
        Schema.decodeUnknownSync(Command)(JSON.parse(value)).operationId ===
          input.operationId
      )
        sessionStorage.removeItem(key)
      if (mounted.current) setSaved(null)
    }
    try {
      sessionStorage.setItem(key, JSON.stringify(input))
      setSaved(input)
      await agentApi(agentId)(`background/${input.action}`, {
        groupId: input.groupId,
        operationId: input.operationId,
      })
      clear()
    } catch (cause) {
      if (confirmedRejection(cause)) clear()
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Acknowledgement lost. Retry the saved action."
        )
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  if (!active && !saved && !error) return null
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={busy || (!active && !saved)}
        onClick={() => void submit()}
      >
        {busy
          ? "Sending…"
          : saved
            ? action === "stop"
              ? "Retry stop"
              : "Retry connection"
            : action === "stop"
              ? "Stop group"
              : "Retry connection"}
      </Button>
      {saved && (
        <p className="text-xs text-muted-foreground">
          Saved action awaiting acknowledgement. Retry uses the same operation.
        </p>
      )}
      {error && (
        <Alert>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
