import { ArrowLeft, Clock3, Plus } from "lucide-react"
import { useEffect, useState } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { Routine, RoutineRun, SaveRoutine } from "@/routines/contracts"

import { useRoutines } from "./use-routines"
import { WebhookPanel } from "./webhook-panel"

const time = (at: number) =>
  new Date(at).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  })
const schedule = (routine: Routine) =>
  routine.schedule.type === "once"
    ? "Once"
    : routine.schedule.type === "webhook"
      ? "On incoming events"
      : `Every ${routine.schedule.minutes} minutes`
export function RoutinesWorkbench({
  agentId,
  onPendingChange,
  selected,
  webhook,
  onSelect,
}: {
  selected: string | null
  webhook: boolean
  onSelect: (id: string | null, webhook?: boolean) => void
  agentId: string
  onPendingChange: (pending: boolean) => void
}) {
  const [newEditor, setNewEditor] = useState<{
    key: string
    routine?: Routine
  } | null>(null)
  const [mutationPending, setMutationPending] = useState(false)
  const actions = useRoutines(
    agentId,
    () => {
      setNewEditor(null)
      onSelect(null)
    },
    setMutationPending
  )
  const selectedRoutine = actions.data.routines.find(
    (value) => value.id === selected
  )
  const editor = routineEditorSelection(newEditor, selectedRoutine, webhook)
  const hook = webhook ? selectedRoutine : undefined
  function setEditor(value: { key: string; routine?: Routine } | null) {
    if (value?.routine) {
      setNewEditor(null)
      onSelect(value.routine.id)
    } else {
      setNewEditor(value)
      if (selected) onSelect(null)
    }
  }
  const setHook = (value: Routine | null) =>
    onSelect(value?.id ?? null, !!value)
  const [hookPending, setHookPending] = useState(false)
  const locked = actions.busy || !!actions.attempt || hookPending
  const editing = editor !== null
  useEffect(() => {
    onPendingChange(mutationPending || locked || editing)
    return () => onPendingChange(false)
  }, [mutationPending, locked, editing, onPendingChange])
  const setStatus = (routine: Routine, status: Routine["status"]) =>
    void actions.send({
      path: "status",
      body: {
        id: routine.id,
        operationId: crypto.randomUUID(),
        expectedRevision: routine.revision,
        status,
      },
    })
  const row = (routine: Routine) => (
    <div
      key={routine.id}
      className="flex flex-col gap-3 border-b py-4 last:border-b-0"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 text-sm font-medium break-words">
          {routine.title}
        </h3>
        <Badge variant="secondary">{routine.status}</Badge>
      </div>
      <p className="line-clamp-2 text-sm whitespace-pre-wrap text-muted-foreground">
        {routine.prompt}
      </p>
      <p className="text-xs text-muted-foreground">
        {schedule(routine)}
        {routine.status === "active" && routine.schedule.type !== "webhook"
          ? routine.nextAt !== null
            ? ` · Next ${time(routine.nextAt)}`
            : " · Schedule complete"
          : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        {routine.status !== "archived" ? (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={locked}
              onClick={() => setEditor({ key: routine.id, routine })}
            >
              Edit
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={locked}
              onClick={() =>
                setStatus(
                  routine,
                  routine.status === "active" ? "paused" : "active"
                )
              }
            >
              {routine.status === "active" ? "Pause" : "Resume"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={
                locked ||
                actions.data.runs.some(
                  (run) => run.status === "pending" || run.status === "queued"
                )
              }
              onClick={() =>
                void actions.send({
                  path: "run",
                  body: {
                    id: routine.id,
                    operationId: crypto.randomUUID(),
                    expectedRevision: routine.revision,
                  },
                })
              }
            >
              Run now
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={locked}
              onClick={() => setHook(routine)}
            >
              Webhook
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={locked}
              onClick={() => setStatus(routine, "archived")}
            >
              Archive
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={locked}
            onClick={() => setStatus(routine, "paused")}
          >
            Restore paused
          </Button>
        )}
      </div>
    </div>
  )
  return (
    <>
      <header className="workbench-heading-row">
        <h2 className="workbench-section-title flex items-center gap-2">
          <Clock3 className="size-4" /> Routines
        </h2>
        {!editor && (
          <Button
            size="sm"
            variant="outline"
            disabled={locked}
            onClick={() => setEditor({ key: crypto.randomUUID() })}
          >
            <Plus data-icon="inline-start" /> New routine
          </Button>
        )}
      </header>
      <div className="workbench-body">
        {actions.error && (
          <Alert>
            <AlertDescription>
              {actions.error}
              {!actions.attempt && (
                <Button
                  variant="link"
                  size="sm"
                  disabled={actions.busy}
                  onClick={() => void actions.retryLoad()}
                >
                  Retry routines
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}
        {actions.attempt && (
          <div className="flex flex-col gap-2 rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">
              {actions.busy
                ? "Confirming your change…"
                : "Keep this request until its result is confirmed."}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={actions.busy}
                onClick={() => void actions.send(actions.attempt!)}
              >
                Retry same change
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={actions.busy}
                onClick={() => void actions.resolve()}
              >
                Resolve and cancel
              </Button>
            </div>
          </div>
        )}
        {selected && !selectedRoutine ? (
          <Alert>
            <AlertDescription>
              {actions.loading
                ? "Loading routine…"
                : "This routine is unavailable."}
              <Button variant="link" onClick={() => onSelect(null)}>
                All routines
              </Button>
            </AlertDescription>
          </Alert>
        ) : hook ? (
          <WebhookPanel
            key={hook.id}
            agentId={agentId}
            routine={hook}
            onBack={() => {
              setHook(null)
              void actions.refresh()
            }}
            onPendingChange={(pending) => {
              setHookPending(pending)
            }}
          />
        ) : editor ? (
          <>
            <Button
              className="self-start"
              size="sm"
              variant="ghost"
              disabled={locked}
              onClick={() => setEditor(null)}
            >
              <ArrowLeft /> All routines
            </Button>
            <RoutineEditor
              key={editor.key}
              routine={editor.routine}
              latest={actions.data.routines.find(
                (r) => r.id === editor.routine?.id
              )}
              locked={locked}
              onSave={(body) => void actions.send({ path: "save", body })}
            />
          </>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Routines continue when you close the app. Tool approvals still
              apply.
            </p>
            {actions.loading ? (
              <p className="text-sm text-muted-foreground" role="status">
                Loading routines…
              </p>
            ) : actions.data.routines.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No routines yet</EmptyTitle>
                  <EmptyDescription>
                    Schedule a task review, prepare a brief or pick up a project
                    at a chosen time.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}
            <div>
              {actions.data.routines
                .filter((r) => r.status !== "archived")
                .map(row)}
            </div>
            {actions.data.routines.some((r) => r.status === "archived") && (
              <details>
                <summary className="cursor-pointer text-xs font-medium">
                  Archived routines
                </summary>
                {actions.data.routines
                  .filter((r) => r.status === "archived")
                  .map(row)}
              </details>
            )}
            <section
              aria-label="Recent routine runs"
              className="flex flex-col gap-3"
            >
              <h3 className="text-sm font-medium">Recent runs</h3>
              {actions.data.runs.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Completed work and interrupted runs appear here.
                </p>
              ) : (
                actions.data.runs
                  .slice(0, 30)
                  .map((run) => (
                    <RunRow
                      key={run.id}
                      run={run}
                      disabled={locked}
                      onStop={() => void actions.stop(run.id)}
                    />
                  ))
              )}
            </section>
          </>
        )}
      </div>
      <footer className="border-t px-4 py-3 text-xs text-muted-foreground">
        One routine runs at a time, with a ten-minute budget. Missed intervals
        become one run. Pause stops future work; use Stop to end a run already
        in progress.
      </footer>
    </>
  )
}
function RunRow({
  run,
  disabled,
  onStop,
}: {
  run: RoutineRun
  disabled: boolean
  onStop: () => void
}) {
  const active = run.status === "pending" || run.status === "queued"
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 text-sm font-medium break-words">
          {run.title}
        </span>
        <Badge variant="outline">
          {run.status === "pending"
            ? "Waiting"
            : run.status === "queued"
              ? "In progress"
              : run.status}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        {time(run.scheduledAt)} ·{" "}
        {run.trigger === "manual"
          ? "Run now"
          : run.trigger === "webhook"
            ? "Incoming event"
            : "Scheduled"}
      </p>
      {run.status === "pending" && (
        <p className="text-xs text-muted-foreground">
          Waiting for the model connection or room in the conversation.
        </p>
      )}
      {run.deadline && active && (
        <p className="text-xs text-muted-foreground">
          Budget ends {time(run.deadline)}. Inspect the conversation for
          progress and approvals.
        </p>
      )}
      {run.error && (
        <p className="text-xs text-muted-foreground">{run.error}</p>
      )}
      {active && (
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          disabled={disabled}
          onClick={onStop}
        >
          Stop run
        </Button>
      )}
    </div>
  )
}
function localTime(at: number) {
  const date = new Date(at)
  return new Date(at - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16)
}
const intervals = [
  { value: 15, label: "Every 15 minutes" },
  { value: 30, label: "Every 30 minutes" },
  { value: 60, label: "Every hour" },
  { value: 120, label: "Every 2 hours" },
  { value: 360, label: "Every 6 hours" },
  { value: 720, label: "Every 12 hours" },
  { value: 1440, label: "Every 24 hours" },
  { value: 10080, label: "Every 7 days" },
]
function RoutineEditor({
  routine,
  latest,
  locked,
  onSave,
}: {
  routine?: Routine
  latest?: Routine
  locked: boolean
  onSave: (input: SaveRoutine) => void
}) {
  const [baseline, setBaseline] = useState(routine)
  const [savedSchedule, setSavedSchedule] = useState(routine?.schedule)
  const conflict = !!latest && latest.revision !== baseline?.revision
  const [initial] = useState(() => routineEditorDefaults(routine))
  const [id] = useState(initial.id)
  const [title, setTitle] = useState(initial.title),
    [prompt, setPrompt] = useState(initial.prompt)
  const [type, setType] = useState(initial.type)
  const [at, setAt] = useState(initial.at)
  const [minutes, setMinutes] = useState(initial.minutes)
  const [changedTime, setChangedTime] = useState(false)
  const [status, setStatus] = useState(initial.status)
  const [error, setError] = useState("")
  const choices = intervals.some((item) => item.value === minutes)
    ? intervals
    : [...intervals, { value: minutes, label: `Every ${minutes} minutes` }]
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        setError("")
        if (conflict) return
        const timestamp = new Date(at).getTime()
        if (type !== "webhook" && !Number.isFinite(timestamp)) {
          setError("Choose a valid first run.")
          return
        }
        onSave({
          id,
          operationId: crypto.randomUUID(),
          expectedRevision: baseline?.revision ?? 0,
          title,
          prompt,
          status,
          schedule:
            !changedTime && savedSchedule
              ? savedSchedule
              : type === "webhook"
                ? { type }
                : type === "once"
                  ? { type, at: timestamp }
                  : { type, at: timestamp, minutes },
        })
      }}
    >
      <fieldset disabled={locked} className="flex flex-col gap-5">
        <h2 className="text-sm font-medium">
          {routine ? "Edit routine" : "New routine"}
        </h2>
        {error && (
          <Alert>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {conflict && (
          <Alert>
            <AlertDescription className="flex flex-col gap-2">
              <p>
                This routine changed elsewhere. Review its current instructions
                before saving your draft.
              </p>
              <p className="text-xs whitespace-pre-wrap">{latest.prompt}</p>
              <p className="text-xs">
                {schedule(latest)} · {latest.status} · First run{" "}
                {latest.schedule.type === "webhook"
                  ? "on demand"
                  : time(latest.schedule.at)}
              </p>
              {latest.status === "archived" ? (
                <p>Return to all routines and restore it before editing.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setBaseline(latest)
                    }}
                  >
                    Keep my edits
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setBaseline(latest)
                      setTitle(latest.title)
                      setPrompt(latest.prompt)
                      setType(latest.schedule.type)
                      setAt(
                        localTime(
                          latest.schedule.type === "webhook"
                            ? Date.now() + 3600000
                            : latest.schedule.at
                        )
                      )
                      setMinutes(
                        latest.schedule.type === "interval"
                          ? latest.schedule.minutes
                          : 60
                      )
                      setStatus(
                        latest.status === "paused" ? "paused" : "active"
                      )
                      setSavedSchedule(latest.schedule)
                      setChangedTime(false)
                    }}
                  >
                    Use saved values
                  </Button>
                </div>
              )}
            </AlertDescription>
          </Alert>
        )}
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="routine-title">Name</FieldLabel>
            <Input
              id="routine-title"
              autoFocus
              required
              pattern=".*\S.*"
              maxLength={80}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Morning project brief"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="routine-prompt">Instructions</FieldLabel>
            <Textarea
              id="routine-prompt"
              required
              maxLength={12000}
              rows={5}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Review my saved project notes and tell me what needs attention."
            />
            <FieldDescription>
              Be specific about what to check and what would be worth reporting.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel>Schedule</FieldLabel>
            <ToggleGroup
              aria-label="Routine schedule"
              value={[type]}
              onValueChange={(values) => {
                if (
                  values[0] === "once" ||
                  values[0] === "interval" ||
                  values[0] === "webhook"
                ) {
                  setType(values[0])
                  setChangedTime(true)
                }
              }}
              variant="outline"
              size="sm"
            >
              <ToggleGroupItem value="once">Once</ToggleGroupItem>
              <ToggleGroupItem value="interval">Repeat</ToggleGroupItem>
              <ToggleGroupItem value="webhook">Events</ToggleGroupItem>
            </ToggleGroup>
          </Field>
          {type !== "webhook" && (
            <Field>
              <FieldLabel htmlFor="routine-time">
                {type === "once" ? "Run at" : "First run"}
              </FieldLabel>
              <Input
                className="min-w-0"
                id="routine-time"
                type="datetime-local"
                required
                value={at}
                onChange={(e) => {
                  setAt(e.target.value)
                  setChangedTime(true)
                }}
              />
              <FieldDescription>
                Time in {Intl.DateTimeFormat().resolvedOptions().timeZone}.
                Repeats use elapsed time, including across clock changes.
              </FieldDescription>
            </Field>
          )}
          {type === "webhook" && (
            <p className="text-xs text-muted-foreground">
              Save the routine, then open Webhook to create its private key. You
              can also use Run now.
            </p>
          )}
          {type === "interval" && (
            <Field>
              <FieldLabel htmlFor="routine-interval">Repeat every</FieldLabel>
              <Select
                items={choices}
                value={minutes}
                onValueChange={(value) => {
                  if (value !== null) {
                    setMinutes(value)
                    setChangedTime(true)
                  }
                }}
              >
                <SelectTrigger id="routine-interval" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {choices.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          )}
          <Field>
            <FieldLabel>After saving</FieldLabel>
            <ToggleGroup
              aria-label="Routine status"
              value={[status]}
              onValueChange={(values) => {
                if (values[0] === "active" || values[0] === "paused")
                  setStatus(values[0])
              }}
              variant="outline"
              size="sm"
            >
              <ToggleGroupItem value="active">Active</ToggleGroupItem>
              <ToggleGroupItem value="paused">Paused</ToggleGroupItem>
            </ToggleGroup>
          </Field>
        </FieldGroup>
        <Button
          type="submit"
          className="self-start"
          disabled={locked || conflict || !title.trim() || !prompt.trim()}
        >
          {routine ? "Save routine" : "Create routine"}
        </Button>
      </fieldset>
    </form>
  )
}

function routineEditorSelection(
  draft: { key: string; routine?: Routine } | null,
  selected: Routine | undefined,
  webhook: boolean
) {
  return (
    draft ??
    (selected && !webhook ? { key: selected.id, routine: selected } : null)
  )
}
function routineEditorDefaults(routine?: Routine) {
  return {
    id: routine?.id ?? crypto.randomUUID(),
    title: routine?.title ?? "",
    prompt: routine?.prompt ?? "",
    type: routine?.schedule.type ?? "once",
    at: localTime(
      routine && routine.schedule.type !== "webhook"
        ? routine.schedule.at
        : Date.now() + 3600000
    ),
    minutes:
      routine?.schedule.type === "interval" ? routine.schedule.minutes : 60,
    status:
      routine?.status === "paused" ? ("paused" as const) : ("active" as const),
  }
}
