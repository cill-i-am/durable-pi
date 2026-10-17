import { useState } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { agentApi } from "@/http/client"
import type { SummaryIssue } from "@/memory/domain"

export function SummaryRecovery({
  agentId,
  issues,
}: {
  agentId: string
  issues: readonly SummaryIssue[]
}) {
  const [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState("")
  const paused = issues.filter((issue) => issue.retryAt === null)
  if (!paused.length) return null
  async function retry(issue: SummaryIssue) {
    const key = `${issue.start}+${issue.count}`
    const storageKey = `memory-retry:${agentId}:${key}`
    setBusy(key)
    setError("")
    try {
      const operationId =
        sessionStorage.getItem(storageKey) ?? crypto.randomUUID()
      sessionStorage.setItem(storageKey, operationId)
      await agentApi(agentId)("memory/retry", {
        start: issue.start,
        count: issue.count,
        operationId,
      })
      if (sessionStorage.getItem(storageKey) === operationId)
        sessionStorage.removeItem(storageKey)
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not retry this summary."
      )
    } finally {
      setBusy(null)
    }
  }
  return (
    <Alert>
      <AlertTitle>Memory summaries paused</AlertTitle>
      <AlertDescription className="flex min-w-0 flex-col gap-2">
        <p>
          These summaries stopped after three unsuccessful attempts. Original
          messages and completed summaries remain saved. Check the ChatGPT
          connection and the Memory summaries job default, then retry with that
          setting.
        </p>
        {paused.map((issue) => (
          <Button
            key={`${issue.start}+${issue.count}`}
            variant="outline"
            size="sm"
            className="h-auto w-full min-w-0 py-2 whitespace-normal"
            disabled={busy !== null}
            onClick={() => void retry(issue)}
          >
            {busy === `${issue.start}+${issue.count}`
              ? "Retrying…"
              : `Retry summary ${issue.start}+${issue.count}`}
          </Button>
        ))}
        {error && <p role="alert">{error}</p>}
      </AlertDescription>
    </Alert>
  )
}
