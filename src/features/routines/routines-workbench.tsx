import { useEffect, useRef, useState } from "react"
import { cn } from "cn"
import { ArrowLeft, Clock3, Plus, X } from "lucide-react"
import type { Routine, RoutineRun, SaveRoutine } from "@/routines/contracts"
import { useRoutines } from "./use-routines"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"

const time = (at: number) =>
  new Date(at).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  })
const schedule = (routine: Routine) =>
  routine.schedule.type === "once"
    ? "Once"
    : `Every ${routine.schedule.minutes} minutes`
export function RoutinesWorkbench({
  agentId,
  agentName,
  onClose,
  onPendingChange,
}: {
  agentId: string
  agentName: string
  onClose: () => void
  onPendingChange: (pending: boolean) => void
}) {
  const [editor, setEditor] = useState<{
    key: string
    routine?: Routine
  } | null>(null)
  const actions = useRoutines(agentId, () => setEditor(null), onPendingChange)
  const [wide, setWide] = useState(false),
    portalContainer = useRef<HTMLDivElement>(null)
  const locked = actions.busy || !!actions.attempt
  useEffect(() => {
    const media = matchMedia("(min-width: 1280px)")
    const update = () => setWide(media.matches)
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])
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
        {routine.status === "active"
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
    <div
      ref={portalContainer}
      className={cn(
        wide && "relative min-h-0 w-[min(42vw,600px)] shrink-0 border-l"
      )}
    >
      <Sheet
        open
        modal={!wide}
        onOpenChange={(open, event) => {
          if (!open && !locked && (!wide || event.reason === "escape-key"))
            onClose()
        }}
      >
        <SheetContent
          portalContainer={portalContainer}
          showOverlay={!wide}
          side="right"
          showCloseButton={false}
          className={cn(
            "flex w-full max-w-full flex-col gap-0 p-0 data-[side=right]:w-full sm:max-w-xl",
            wide &&
              "absolute shadow-none data-[side=right]:w-full data-[side=right]:border-l-0 data-[side=right]:sm:max-w-none"
          )}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{agentName} routines</SheetTitle>
            <SheetDescription>
              Schedule this bot's work and inspect recent runs.
            </SheetDescription>
          </SheetHeader>
          <header className="flex items-center justify-between border-b px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Clock3 className="size-4" /> Routines
            </div>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Hide routines"
              disabled={locked}
              onClick={onClose}
            >
              <X />
            </Button>
          </header>
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
            {actions.error && (
              <Alert>
                <AlertDescription>{actions.error}</AlertDescription>
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
            {editor ? (
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
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-sm font-medium">Work with {agentName}</h2>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={locked}
                    onClick={() => setEditor({ key: crypto.randomUUID() })}
                  >
                    <Plus /> New routine
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Runs on Cloudflare with this browser closed. Results appear in
                  this conversation. Your tool permissions and approvals still
                  apply.
                </p>
                {actions.loading ? (
                  <p className="text-sm text-muted-foreground" role="status">
                    Loading routines…
                  </p>
                ) : actions.data.routines.length === 0 ? (
                  <Empty>
                    <EmptyHeader>
                      <EmptyTitle>A little ahead of you</EmptyTitle>
                      <EmptyDescription>
                        Schedule a task review, prepare a brief or pick up a
                        project at a chosen time.
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
                  <h2 className="text-sm font-medium">Recent runs</h2>
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
            One routine runs at a time, with a ten-minute budget. Missed
            intervals become one run. Pause stops future work; use Stop to end a
            run already in progress.
          </footer>
        </SheetContent>
      </Sheet>
    </div>
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
        {run.trigger === "manual" ? "Run now" : "Scheduled"}
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
  const [id] = useState(() => routine?.id ?? crypto.randomUUID())
  const [title, setTitle] = useState(routine?.title ?? ""),
    [prompt, setPrompt] = useState(routine?.prompt ?? "")
  const [type, setType] = useState<"once" | "interval">(
    routine?.schedule.type ?? "once"
  )
  const [at, setAt] = useState(() =>
    localTime(routine?.schedule.at ?? Date.now() + 3600000)
  )
  const [minutes, setMinutes] = useState(
    routine?.schedule.type === "interval" ? routine.schedule.minutes : 60
  )
  const [changedTime, setChangedTime] = useState(false)
  const [status, setStatus] = useState<"active" | "paused">(
    routine?.status === "paused" ? "paused" : "active"
  )
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
        if (!Number.isFinite(timestamp)) {
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
                {time(latest.schedule.at)}
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
                      setAt(localTime(latest.schedule.at))
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
              required
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
                if (values[0] === "once" || values[0] === "interval") {
                  setType(values[0])
                  setChangedTime(true)
                }
              }}
              variant="outline"
              size="sm"
            >
              <ToggleGroupItem value="once">Once</ToggleGroupItem>
              <ToggleGroupItem value="interval">Repeat</ToggleGroupItem>
            </ToggleGroup>
          </Field>
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
