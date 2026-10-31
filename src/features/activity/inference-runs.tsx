import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Schema } from "effect"
import { ChevronDown } from "lucide-react"

import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible"
import { InferenceActivity, type Attempt } from "@/inference/usage-domain"

import { activityJsonRequest } from "./query-owner"
import { useActivityQuery } from "./use-activity-query"

export function InferenceRuns({ agentId }: { agentId: string }) {
  const { data, error, refresh } = useActivityQuery({
    key: JSON.stringify(["inference", agentId]),
    interval: 2500,
    read: async (signal) =>
      Schema.decodeUnknownSync(InferenceActivity)(
        await activityJsonRequest(agentId, "inference", signal)
      ),
    errorMessage:
      "Model activity could not reconnect. Saved records will return when the connection recovers.",
  })
  const attempts = data?.attempts ?? []
  return (
    <Collapsible defaultOpen>
      <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
        <ChevronDown /> Model activity
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 pt-3">
        <p className="text-xs text-muted-foreground">
          ChatGPT plan usage · reported tokens, including cached input. No API
          cost estimates.
        </p>
        {error && (
          <Alert>
            <AlertDescription>
              {error}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refresh()}
              >
                Reconnect
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {!attempts.length && !error && (
          <p className="text-sm text-muted-foreground">
            Model requests will appear here as your agent works.
          </p>
        )}
        {attempts.map((attempt) => (
          <InferenceRun key={attempt.id} attempt={attempt} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}
export function InferenceRun({ attempt }: { attempt: Attempt }) {
  const duration =
    attempt.finishedAt && attempt.outcome !== "interrupted"
      ? Math.max(
          0,
          Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt)
        )
      : null
  return (
    <div className="flex flex-col gap-2 border-b pb-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          {attempt.route.model} · {attempt.route.thinking}
        </span>
        <Badge
          variant={attempt.outcome === "completed" ? "secondary" : "outline"}
        >
          {attempt.outcome}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        {attempt.purpose} · {attempt.route.job} · {attempt.route.reason} ·{" "}
        {attempt.outcome === "interrupted"
          ? "Duration unknown after restart"
          : duration === null
            ? "In progress"
            : `${(duration / 1000).toFixed(1)}s`}
      </p>
      <p className="text-xs text-muted-foreground">
        {attempt.input === null
          ? "Provider usage not reported"
          : `${attempt.input.toLocaleString()} input · ${attempt.cached?.toLocaleString()} cached · ${attempt.output?.toLocaleString()} output`}
      </p>
      {attempt.reportedModel &&
        attempt.reportedModel !== attempt.route.model && (
          <p className="text-xs text-muted-foreground">
            Provider reported: {attempt.reportedModel}
          </p>
        )}
      {attempt.error && (
        <p className="text-xs text-destructive">{attempt.error}</p>
      )}
      <span className="text-xs text-muted-foreground">
        {new Date(attempt.startedAt).toLocaleString()} ·{" "}
        {attempt.route.policyVersion}
      </span>
    </div>
  )
}
