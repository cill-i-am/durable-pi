import { useEffect, useRef, useState } from "react"
import { Schema } from "effect"
import { ChevronDown, GitBranch, Square } from "lucide-react"
import {
  Group,
  Transcript,
  type Child,
  type Control,
} from "@/delegation/contracts"
import { agentApi } from "@/http/client"
import { poll } from "@/http/poll"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card"
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible"
import { Field, FieldLabel, FieldGroup } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import { Skeleton } from "@/components/ui/skeleton"
import {
  acknowledgeControl,
  confirmedRejection,
  controlKey,
  pendingControl,
} from "./delegation-commands"

const Page = Schema.Struct({
  groups: Schema.Array(Group),
  nextOffset: Schema.NullOr(Schema.Number),
})
export function DelegatedWork({ agentId }: { agentId: string }) {
  const [page, setPage] = useState<typeof Page.Type>({
      groups: [],
      nextOffset: null,
    }),
    [offset, setOffset] = useState(0),
    [error, setError] = useState("")
  useEffect(() => {
    let active = true
    setPage({ groups: [], nextOffset: null })
    const stop = poll(
      async () => {
        if (document.visibilityState !== "visible") return
        try {
          const value = Schema.decodeUnknownSync(Page)(
            await agentApi(agentId)(`delegations?offset=${offset}`)
          )
          if (active) {
            setPage(value)
            setError("")
          }
        } catch (cause) {
          if (active)
            setError(
              cause instanceof Error
                ? cause.message
                : "Delegated work could not reconnect."
            )
        }
      },
      2000,
      true
    )
    return () => {
      active = false
      stop()
    }
  }, [agentId, offset])
  if (!page.groups.length && !error && offset === 0) return null
  return (
    <section
      className="flex min-w-0 flex-col gap-[18px]"
      aria-label="Delegated work"
    >
      <div className="flex flex-col gap-2">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <GitBranch className="size-4" /> Working together
        </h3>
        <p className="text-sm text-muted-foreground">
          Independent branches of the same request. Your agent brings the
          results together.
        </p>
      </div>
      {error && (
        <Alert>
          <AlertTitle>Updates interrupted</AlertTitle>
          <AlertDescription>
            {error} Reconnecting automatically.
          </AlertDescription>
        </Alert>
      )}
      {page.groups.map((group) => (
        <DelegationGroup key={group.id} group={group} agentId={agentId} />
      ))}
      <div className="flex flex-wrap justify-between gap-2">
        {offset > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setOffset(Math.max(0, offset - 20))}
          >
            Newer groups
          </Button>
        )}
        {page.nextOffset !== null && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setOffset(page.nextOffset!)}
          >
            Earlier groups
          </Button>
        )}
      </div>
    </section>
  )
}
export function DelegationGroup({
  group,
  agentId,
}: {
  group: Group
  agentId: string
}) {
  const done = group.children.filter((child) =>
    ["completed", "failed", "cancelled"].includes(child.status)
  ).length
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Card>
        <CardHeader>
          <CardTitle>{group.objective}</CardTitle>
          <CardDescription>
            {done} of {group.children.length} branches settled ·{" "}
            {group.status === "completed"
              ? "Report ready"
              : group.status === "cancelled"
                ? "Stopped with parent"
                : "Parent is waiting for results"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            {group.route.model} · {group.route.thinking} · ChatGPT plan usage
          </p>
        </CardContent>
      </Card>
      <div className="flex min-w-0 flex-col gap-3 border-l pl-[18px]">
        {group.children.map((child) => (
          <ChildCard
            key={child.id}
            child={child}
            group={group}
            agentId={agentId}
          />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Shared: this bot’s reference context and parent steering. Selected read
        tools only. Up to 12 model requests per child and 10 minutes per group;
        stopping the parent stops its children.
      </p>
    </div>
  )
}
function ChildCard({
  child,
  group,
  agentId,
}: {
  child: Child
  group: Group
  agentId: string
}) {
  const [inspect, setInspect] = useState(false)
  const running =
    group.status === "working" &&
    ["queued", "working", "stopping"].includes(child.status)
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{child.name}</CardTitle>
          <Badge
            variant={child.status === "failed" ? "destructive" : "secondary"}
          >
            {child.status}
          </Badge>
        </div>
        <CardDescription>{child.task}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          {child.tools.length ? child.tools.join(" · ") : "No tools"} ·{" "}
          {child.requests}/12 requests
        </p>
        {child.inputTokens !== null && (
          <p className="text-xs text-muted-foreground">
            {child.inputTokens.toLocaleString()} input ·{" "}
            {child.outputTokens?.toLocaleString()} output tokens, including
            compaction
          </p>
        )}
        {child.error && (
          <Alert>
            <AlertDescription>{child.error}</AlertDescription>
          </Alert>
        )}
        {child.answer && (
          <p className="text-sm whitespace-pre-wrap">{child.answer}</p>
        )}
        {!!child.steering.length && (
          <Collapsible>
            <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
              <ChevronDown data-icon="inline-start" /> Steering history (
              {child.steering.length})
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
                {child.steering.map((text, i) => (
                  <li key={i}>{text}</li>
                ))}
              </ol>
            </CollapsibleContent>
          </Collapsible>
        )}
        <ChildControl
          agentId={agentId}
          groupId={group.id}
          child={child}
          action="steer"
          active={running && child.status !== "stopping"}
        />
        {inspect && (
          <ChildTranscript
            key={child.id}
            agentId={agentId}
            groupId={group.id}
            childId={child.id}
          />
        )}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setInspect(!inspect)}
        >
          {inspect ? "Close task" : "Open task"}
        </Button>
        <ChildControl
          agentId={agentId}
          groupId={group.id}
          child={child}
          action="stop"
          active={running && child.status !== "stopping"}
        />
      </CardFooter>
    </Card>
  )
}
function ChildControl({
  agentId,
  groupId,
  child,
  action,
  active,
}: {
  agentId: string
  groupId: number
  child: Child
  action: "stop" | "steer"
  active: boolean
}) {
  const key = controlKey(agentId, groupId, child.id, action),
    mounted = useRef(true),
    pending = useRef<Control | null>(null)
  const [text, setText] = useState(""),
    [uncertain, setUncertain] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("")
  useEffect(() => {
    mounted.current = true
    pending.current = pendingControl(sessionStorage, key)
    setUncertain(!!pending.current)
    return () => {
      mounted.current = false
    }
  }, [key])
  async function submit() {
    if (busy || (!active && !pending.current)) return
    setBusy(true)
    setError("")
    let input = pending.current
    try {
      input ??= {
        groupId,
        childId: child.id,
        operationId: crypto.randomUUID(),
        action:
          action === "stop"
            ? { type: "stop" }
            : { type: "steer", text: text.trim() },
      }
      sessionStorage.setItem(key, JSON.stringify(input))
      pending.current = input
      await agentApi(agentId)("delegations/control", input)
      acknowledgeControl(sessionStorage, key, input.operationId)
      pending.current = null
      if (mounted.current) {
        setUncertain(false)
        setText("")
      }
    } catch (cause) {
      const final = confirmedRejection(cause)
      if (final && input) {
        acknowledgeControl(sessionStorage, key, input.operationId)
        pending.current = null
      }
      if (mounted.current) {
        setUncertain(!!pending.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Acknowledgement lost. Retry this saved control."
        )
      }
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  if (!active && !uncertain && !error) return null
  const button = (
    <Button
      size="sm"
      variant="outline"
      disabled={
        busy ||
        (!active && !uncertain) ||
        (action === "steer" && !uncertain && !text.trim())
      }
      onClick={() => void submit()}
    >
      {action === "stop" && <Square data-icon="inline-start" />}
      {busy
        ? "Sending…"
        : uncertain
          ? `Retry saved ${action}`
          : action === "stop"
            ? "Stop task"
            : "Send steering"}
    </Button>
  )
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {action === "steer" ? (
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`steer-${child.id}`}>
              Steer {child.name}
            </FieldLabel>
            <Textarea
              id={`steer-${child.id}`}
              value={
                uncertain && pending.current?.action.type === "steer"
                  ? pending.current.action.text
                  : text
              }
              maxLength={8000}
              disabled={busy || uncertain || !active}
              onChange={(event) => setText(event.target.value)}
              placeholder="Refine this branch’s brief…"
            />
            {button}
          </Field>
        </FieldGroup>
      ) : (
        button
      )}
      {uncertain && (
        <p className="text-xs text-muted-foreground">
          Saved control awaiting acknowledgement. Retry sends the same
          operation.
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
function ChildTranscript({
  agentId,
  groupId,
  childId,
}: {
  agentId: string
  groupId: number
  childId: number
}) {
  const [page, setPage] = useState<Transcript | null>(null),
    [cursor, setCursor] = useState<string | undefined>(),
    [error, setError] = useState("")
  useEffect(() => {
    let active = true
    setPage(null)
    setError("")
    const stop = poll(
      async () => {
        if (document.visibilityState !== "visible") return
        try {
          const value = Schema.decodeUnknownSync(Transcript)(
            await agentApi(agentId)(
              `delegations/${groupId}/${childId}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`
            )
          )
          if (active) {
            setPage(value)
            setError("")
          }
        } catch (cause) {
          if (active)
            setError(
              cause instanceof Error ? cause.message : "Task could not load."
            )
        }
      },
      cursor ? 10000 : 2000,
      true
    )
    return () => {
      active = false
      stop()
    }
  }, [agentId, groupId, childId, cursor])
  return (
    <section
      className="flex min-w-0 flex-col gap-3"
      aria-label="Child transcript"
    >
      <h4 className="text-sm font-medium">Native task history</h4>
      <p className="text-xs text-muted-foreground">
        Newest first. Large entries are shortened for display; originals remain
        in the child conversation.
      </p>
      {error ? (
        <Alert>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : !page ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        page.entries.map((entry) => (
          <Collapsible key={entry.id}>
            <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
              <ChevronDown data-icon="inline-start" />{" "}
              {entry.kind.replace("pi.", "")} · {entry.id}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="max-h-80 overflow-auto text-xs wrap-anywhere whitespace-pre-wrap">
                {entry.text}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        ))
      )}
      <div className="flex flex-wrap gap-2">
        {cursor && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setCursor(undefined)}
          >
            Latest entries
          </Button>
        )}
        {page?.cursor && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setCursor(page.cursor!)}
          >
            Earlier entries
          </Button>
        )}
      </div>
    </section>
  )
}
