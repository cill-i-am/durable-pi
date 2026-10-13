import { useEffect, useId, useState } from "react"
import { cn } from "cn"
import { Schema } from "effect"
import {
  ArrowUpRight,
  Archive,
  Check,
  Pencil,
  Plus,
  RotateCcw,
} from "lucide-react"
import {
  type Checklist,
  ChecklistTask,
  type ObjectMutation,
  type ChecklistChange,
  ObjectId,
  OriginConversation,
  TaskStatus,
  objectSummary,
} from "@/objects/contracts"
import { agentApi } from "@/http/client"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { Markdown } from "@/components/markdown"
import type { ObjectStore } from "./store"
import { useObjects, useObjectState } from "./context"

export const statusLabels = {
  pending: "To do",
  active: "In progress",
  blocked: "Blocked",
  completed: "Done",
}
const mutation = (
  object: Checklist,
  changes: readonly ChecklistChange[],
  surface: "chat" | "workbench" = "workbench"
) => ({
  surface,
  id: object.id,
  operationId: crypto.randomUUID(),
  expectedRevision: object.revision,
  action: { type: "update" as const, changes },
})
const dateLabel = (date: string) =>
  new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  })

export function SaveState({ store, id }: { store: ObjectStore; id: string }) {
  const state = useObjectState(store),
    problem = state.problems[id],
    current = state.details[id]?.object
  if (state.busy[id])
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Saving…
      </p>
    )
  if (!problem && (state.confirmed[id] ?? 0) > (current?.revision ?? 0))
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Saved. Reconnecting to the current checklist…
      </p>
    )
  if (problem)
    return (
      <Alert className="checklist-save-problem" data-kind={problem.kind}>
        <AlertTitle>
          {problem.kind === "conflict"
            ? "A newer version may be saved"
            : problem.kind === "uncertain"
              ? "Save not confirmed"
              : "Could not save"}
        </AlertTitle>
        <AlertDescription className="flex flex-col gap-3">
          <p>{problem.message}</p>
          {problem.kind === "conflict" && (
            <>
              <p className="checklist-draft-notice">
                Your change was based on revision{" "}
                {problem.input.expectedRevision}. Latest saved revision:{" "}
                {current?.revision ?? "unavailable"}. Your draft is kept. Review
                the saved values before applying it again.
              </p>
              <ChangeComparison input={problem.input} current={current} />
            </>
          )}
          <div className="flex flex-wrap gap-2">
            {state.pending[id] ? (
              <>
                <Button size="sm" onClick={() => void store.retry(id)}>
                  Retry same save
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void store.cancel(id)}
                >
                  Cancel pending save
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => store.dismiss(id)}
              >
                Keep latest saved version
              </Button>
            )}
            {problem.kind === "conflict" &&
              problem.input.action.type === "update" &&
              current &&
              !current.archived &&
              !state.pending[id] && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void store.reapply(id)}
                >
                  Apply my change to revision {current.revision}
                </Button>
              )}
          </div>
        </AlertDescription>
      </Alert>
    )
  return (
    <p
      role="status"
      className="flex items-center gap-1 text-xs text-muted-foreground"
    >
      <Check className="size-3" /> Saved
      {current ? ` · Revision ${current.revision}` : ""}
    </p>
  )
}

export function ChecklistRows({
  object,
  store,
  compact,
  disabled,
  onEdit,
}: {
  object: Checklist
  store: ObjectStore
  compact?: boolean
  disabled: boolean
  onEdit?: (task: ChecklistTask) => void
}) {
  const instance = useId(),
    visible = object.tasks.filter((task) => !task.archived)
  return (
    <div className="checklist-rows" data-compact={!!compact}>
      {(compact ? visible.slice(0, 4) : visible).map((task) => (
        <div key={task.id} className="checklist-row" data-status={task.status}>
          <div className="flex size-6 shrink-0 items-center justify-center">
            <Checkbox
              id={`${instance}-${task.id}`}
              aria-label={`${task.status === "completed" ? "Reopen" : "Complete"} ${task.title}`}
              checked={task.status === "completed"}
              disabled={disabled || object.archived}
              onCheckedChange={(checked) =>
                void store.submit(
                  mutation(
                    object,
                    [
                      {
                        type: "edit_task",
                        taskId: task.id,
                        patch: { status: checked ? "completed" : "pending" },
                      },
                    ],
                    compact ? "chat" : "workbench"
                  )
                )
              }
            />
          </div>
          <label
            htmlFor={`${instance}-${task.id}`}
            className={cn(
              "checklist-task-label",
              task.status === "completed" &&
                "text-muted-foreground line-through"
            )}
          >
            {task.title}
          </label>
          <span className="checklist-task-meta">
            <span>{statusLabels[task.status]}</span>
            {task.dueDate && <span>{dateLabel(task.dueDate)}</span>}
          </span>
          {!compact && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="checklist-edit-task"
              aria-label={`Edit ${task.title}`}
              disabled={disabled || object.archived}
              onClick={() => onEdit?.(task)}
            >
              <Pencil />
            </Button>
          )}
        </div>
      ))}
      {compact && visible.length > 4 && (
        <p className="pt-2 text-xs text-muted-foreground">
          +{visible.length - 4} more tasks
        </p>
      )}
    </div>
  )
}

export function InlineObject({ output }: { output: string }) {
  const context = useObjects()
  let id: string
  try {
    const result: unknown = JSON.parse(output)
    const data = Schema.decodeUnknownSync(
      Schema.Union([
        Schema.Struct({ objectId: ObjectId }),
        Schema.Struct({ object: Schema.Struct({ id: ObjectId }) }),
      ])
    )(result)
    id = "objectId" in data ? data.objectId : data.object.id
  } catch {
    return null
  }
  return context ? (
    <InlineChecklist
      id={id}
      store={context.store}
      open={() => context.open(id)}
      archived={context.archived}
    />
  ) : null
}
function InlineChecklist({
  id,
  store,
  open,
  archived,
}: {
  id: string
  store: ObjectStore
  open: () => void
  archived: boolean
}) {
  const state = useObjectState(store),
    object = state.details[id]?.object
  useEffect(() => {
    void store.load(id)
  }, [store, id])
  return (
    <section aria-label="Live project checklist" className="inline-checklist">
      {object ? (
        <>
          <div className="inline-checklist-heading">
            <h2>{object.title}</h2>
            <Badge variant="secondary" className="checklist-live-badge">
              {object.archived ? "Archived" : "Live checklist"}
            </Badge>
          </div>
          <ChecklistRows
            object={object}
            store={store}
            compact
            disabled={archived || !!state.pending[id]}
          />
          <SaveState store={store} id={id} />
        </>
      ) : (
        <>
          <Skeleton className="h-5 w-40" />
          <p className="text-sm text-muted-foreground">
            {state.error || "Loading saved checklist…"}
          </p>
        </>
      )}
      <footer className="inline-checklist-footer">
        <Button variant="link" size="sm" onClick={open}>
          Open checklist
          <ArrowUpRight data-icon="inline-end" />
        </Button>
        {object && (
          <span>
            {objectSummary(object).completed} of {objectSummary(object).total}
          </span>
        )}
      </footer>
    </section>
  )
}

type Draft = {
  baseTitle: string
  baseNotes: string
  revision: number
  task?: ChecklistTask
  newTask?: boolean
  title: string
  notes: string
  status: typeof TaskStatus.Type
  dueDate: string
}
export function ChecklistView({
  id,
  store,
  agentId,
  archived,
  onEditing,
}: {
  id: string
  store: ObjectStore
  agentId: string
  archived: boolean
  onEditing: (editing: boolean) => void
}) {
  const state = useObjectState(store),
    detail = state.details[id],
    object = detail?.object
  const [draft, setDraft] = useState<Draft | null>(null),
    [origin, setOrigin] = useState<OriginConversation | null>(null),
    [originError, setOriginError] = useState("")
  const [submitted, setSubmitted] = useState<string | null>(null)
  useEffect(() => {
    void store.load(id)
  }, [store, id])
  useEffect(() => {
    onEditing(!!draft)
    return () => onEditing(false)
  }, [draft, onEditing])
  useEffect(() => {
    if (submitted && state.settled[submitted]) {
      setDraft(null)
      setSubmitted(null)
    }
  }, [submitted, state.settled])
  if (!object)
    return (
      <>
        <Skeleton className="h-7 w-44" />
        <p>{state.error || "Loading checklist…"}</p>
        <Button variant="outline" onClick={() => void store.load(id)}>
          Retry
        </Button>
      </>
    )
  const busy = !!state.pending[id],
    disabled = archived || busy || !!draft,
    summary = objectSummary(object)
  const edit = (task?: ChecklistTask, newTask = false) =>
    setDraft({
      baseTitle: object.title,
      baseNotes: object.notes,
      revision: object.revision,
      task,
      newTask,
      title: task?.title ?? (newTask ? "" : object.title),
      notes: task?.notes ?? (newTask ? "" : object.notes),
      status: task?.status ?? "pending",
      dueDate: task?.dueDate ?? "",
    })
  const submit = () => {
    if (!draft) return
    const changes: ChecklistChange[] = draft.newTask
      ? [
          {
            type: "add_task",
            task: {
              id: crypto.randomUUID(),
              title: draft.title,
              notes: draft.notes,
              status: draft.status,
              dueDate: draft.dueDate || null,
            },
          },
        ]
      : draft.task
        ? [
            {
              type: "edit_task",
              taskId: draft.task.id,
              patch: {
                ...(draft.title !== draft.task.title
                  ? { title: draft.title }
                  : {}),
                ...(draft.notes !== draft.task.notes
                  ? { notes: draft.notes }
                  : {}),
                ...(draft.status !== draft.task.status
                  ? { status: draft.status }
                  : {}),
                ...((draft.dueDate || null) !== draft.task.dueDate
                  ? { dueDate: draft.dueDate || null }
                  : {}),
              },
            },
          ]
        : [
            {
              type: "edit",
              ...(draft.title !== draft.baseTitle
                ? { title: draft.title }
                : {}),
              ...(draft.notes !== draft.baseNotes
                ? { notes: draft.notes }
                : {}),
            },
          ]
    if (
      (changes[0]?.type === "edit_task" &&
        !Object.keys(changes[0].patch).length) ||
      (changes[0]?.type === "edit" && Object.keys(changes[0]).length === 1)
    ) {
      setDraft(null)
      return
    }
    const input = {
      ...mutation(object, changes),
      expectedRevision: draft.revision,
    }
    setSubmitted(input.operationId)
    void store.submit(input)
  }
  return (
    <div className="checklist-view">
      <div className="checklist-heading">
        <div className="min-w-0">
          <h2>{object.title}</h2>
        </div>
        {object.archived && <Badge variant="secondary">Archived</Badge>}
      </div>
      {object.notes && <p className="checklist-notes">{object.notes}</p>}
      <div className="checklist-summary">
        <p className="checklist-progress">
          {summary.completed} of {summary.total} complete
        </p>
        <SaveState store={store} id={id} />
      </div>
      {object.archived && (
        <Alert className="checklist-archived">
          <AlertTitle>Archived checklist</AlertTitle>
          <AlertDescription>
            Tasks and history are kept. Restore it to continue.
            <Button
              variant="outline"
              className="mt-3"
              disabled={archived || busy}
              onClick={() =>
                void store.submit(
                  mutation(object, [{ type: "archive", archived: false }])
                )
              }
            >
              <RotateCcw data-icon="inline-start" />
              Restore checklist
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <Tabs defaultValue="tasks" className="checklist-tabs">
        <TabsList variant="line">
          <TabsTrigger value="tasks">Tasks</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="tasks" className="flex flex-col gap-4">
          <ChecklistRows
            object={object}
            store={store}
            disabled={disabled}
            onEdit={(task) => edit(task)}
          />
          {!object.tasks.length && (
            <p className="py-4 text-sm text-muted-foreground">
              Add the first task to this project.
            </p>
          )}
          {!object.archived && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={disabled}
                onClick={() => edit(undefined, true)}
              >
                <Plus data-icon="inline-start" />
                Add task
              </Button>
              <Button
                variant="ghost"
                disabled={disabled}
                onClick={() => edit()}
              >
                Edit checklist
              </Button>
            </div>
          )}
          {draft && (
            <TaskEditor
              draft={draft}
              disabled={
                busy ||
                archived ||
                object.archived ||
                state.problems[id]?.kind === "conflict"
              }
              cancelDisabled={busy}
              onChange={setDraft}
              onSave={submit}
              onCancel={() => {
                if (!busy) {
                  setDraft(null)
                  store.dismiss(id)
                }
              }}
            />
          )}
          {object.tasks.some((task) => task.archived) && (
            <details>
              <summary className="cursor-pointer text-sm">
                Archived tasks
              </summary>
              <div className="mt-3 flex flex-col gap-2">
                {object.tasks
                  .filter((task) => task.archived)
                  .map((task) => (
                    <div key={task.id} className="flex items-center gap-3">
                      <span className="min-w-0 flex-1 text-sm break-words">
                        {task.title}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={disabled || object.archived}
                        onClick={() =>
                          void store.submit(
                            mutation(object, [
                              {
                                type: "edit_task",
                                taskId: task.id,
                                patch: { archived: false },
                              },
                            ])
                          )
                        }
                      >
                        Restore task
                      </Button>
                    </div>
                  ))}
              </div>
            </details>
          )}
          {draft?.task && (
            <Button
              variant="ghost"
              className="self-start"
              disabled={
                busy ||
                archived ||
                object.archived ||
                state.problems[id]?.kind === "conflict"
              }
              onClick={() => {
                const input = {
                  ...mutation(object, [
                    {
                      type: "edit_task",
                      taskId: draft.task!.id,
                      patch: { archived: true },
                    },
                  ]),
                  expectedRevision: draft.revision,
                }
                setSubmitted(input.operationId)
                void store.submit(input)
              }}
            >
              <Archive data-icon="inline-start" />
              Archive task
            </Button>
          )}
        </TabsContent>
        <TabsContent value="history">
          <div className="checklist-history">
            {detail.events.map((event) => (
              <article key={event.id}>
                <div className="flex flex-wrap justify-between gap-2 text-sm">
                  <strong>
                    {event.source.actor === "user" ? "You" : "Agent"}
                  </strong>
                  <time
                    className="text-xs text-muted-foreground"
                    dateTime={event.at}
                  >
                    {new Date(event.at).toLocaleString()} · r{event.revision}
                  </time>
                </div>
                <p className="text-xs text-muted-foreground">
                  {event.source.actor === "agent"
                    ? `Agent tool · ${event.source.toolCallId}`
                    : event.source.surface === "chat"
                      ? "Inline chat edit"
                      : "Workbench edit"}
                </p>
                {event.changes.map((change, index) => (
                  <div key={index} className="text-sm break-words">
                    <p className="font-medium">
                      {change.taskId
                        ? (object.tasks.find(
                            (task) => task.id === change.taskId
                          )?.title ?? "Task")
                        : "Checklist"}{" "}
                      · {change.field}
                    </p>
                    {change.field === "added" ? (
                      <p className="text-muted-foreground">
                        <AddedTask value={change.after} />
                      </p>
                    ) : (
                      <p className="whitespace-pre-wrap">
                        <span className="text-muted-foreground">
                          {displayValue(change.before)}
                        </span>{" "}
                        → {displayValue(change.after)}
                      </p>
                    )}
                  </div>
                ))}
              </article>
            ))}
          </div>
          {detail.nextHistory !== null && (
            <Button variant="outline" onClick={() => void store.history(id)}>
              Earlier changes
            </Button>
          )}
        </TabsContent>
      </Tabs>
      <p className="text-xs text-muted-foreground">
        Your agent sees edits on your next message.
      </p>
      {object.origin.turnId ? (
        <Button
          variant="link"
          className="h-auto justify-start p-0"
          onClick={() => {
            void agentApi(agentId)(`objects/${id}/origin`)
              .then((value) => {
                setOrigin(Schema.decodeUnknownSync(OriginConversation)(value))
                setOriginError("")
              })
              .catch(() =>
                setOriginError(
                  "Could not open the originating conversation. Try again."
                )
              )
          }}
        >
          From the conversation
          <ArrowUpRight data-icon="inline-end" />
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">
          Created in the workbench.
        </p>
      )}
      {originError && (
        <p role="alert" className="text-sm text-destructive">
          {originError}
        </p>
      )}
      {!object.archived && (
        <Button
          variant="outline"
          className="self-start"
          disabled={disabled}
          onClick={() =>
            void store.submit(
              mutation(object, [{ type: "archive", archived: true }])
            )
          }
        >
          <Archive data-icon="inline-start" />
          Archive checklist
        </Button>
      )}
      <Dialog
        open={!!origin}
        onOpenChange={(open) => {
          if (!open) setOrigin(null)
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Originating conversation</DialogTitle>
            <DialogDescription>
              {origin ? new Date(origin.createdAt).toLocaleString() : ""}
            </DialogDescription>
          </DialogHeader>
          {origin && (
            <div className="flex min-w-0 flex-col gap-5">
              <p className="whitespace-pre-wrap">{origin.text}</p>
              <Markdown text={origin.answer} />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
function TaskEditor({
  draft,
  disabled,
  cancelDisabled,
  onChange,
  onSave,
  onCancel,
}: {
  draft: Draft
  disabled: boolean
  cancelDisabled: boolean
  onChange: (draft: Draft) => void
  onSave: () => void
  onCancel: () => void
}) {
  const id = useId(),
    task = !!draft.task || draft.newTask
  return (
    <form
      className="checklist-task-editor"
      onSubmit={(event) => {
        event.preventDefault()
        onSave()
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">
          {draft.newTask
            ? "New task"
            : draft.task
              ? `Edit task · ${draft.task.title}`
              : "Edit checklist"}
        </h3>
        <Badge variant="secondary" className="checklist-unsaved-badge">
          Unsaved
        </Badge>
      </div>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`${id}-title`}>Title</FieldLabel>
          <Input
            id={`${id}-title`}
            autoFocus
            className="min-h-11"
            required
            maxLength={120}
            value={draft.title}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...draft, title: event.target.value })
            }
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-notes`}>Supporting notes</FieldLabel>
          <Textarea
            id={`${id}-notes`}
            maxLength={task ? 2000 : 4000}
            value={draft.notes}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...draft, notes: event.target.value })
            }
          />
        </Field>
        {task && (
          <div className="checklist-task-fields">
            <Field>
              <FieldLabel htmlFor={`${id}-status`}>Status</FieldLabel>
              <Select
                value={draft.status}
                onValueChange={(value) => {
                  if (Schema.is(TaskStatus)(value))
                    onChange({ ...draft, status: value })
                }}
                disabled={disabled}
                items={statusLabels}
              >
                <SelectTrigger id={`${id}-status`} className="min-h-11 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {Object.entries(statusLabels).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-date`}>
                Due date (optional)
              </FieldLabel>
              <Input
                id={`${id}-date`}
                className="min-h-11 min-w-0"
                type="date"
                value={draft.dueDate}
                disabled={disabled}
                onInput={(event) =>
                  onChange({ ...draft, dueDate: event.currentTarget.value })
                }
                onChange={(event) =>
                  onChange({ ...draft, dueDate: event.target.value })
                }
              />
            </Field>
          </div>
        )}
      </FieldGroup>
      <div className="flex gap-2">
        <Button
          className="min-h-11"
          type="submit"
          disabled={disabled || !draft.title.trim()}
        >
          Save changes
        </Button>
        <Button
          className="min-h-11"
          type="button"
          variant="outline"
          disabled={cancelDisabled}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}

const fieldLabel = (field: string) =>
  ({
    title: "Title",
    notes: "Notes",
    status: "Status",
    dueDate: "Due date",
    archived: "Archived",
    added: "Added",
    created: "Created",
  })[field] ?? field
const displayValue = (value: unknown) =>
  typeof value === "string" && value in statusLabels
    ? statusLabels[value as keyof typeof statusLabels]
    : value === null || value === "" || value === undefined
      ? "None"
      : String(value)
function AddedTask({ value }: { value: string | null }) {
  try {
    const task = Schema.decodeUnknownSync(ChecklistTask)(
      JSON.parse(value ?? "null")
    )
    return (
      <span>
        {task.title} · {statusLabels[task.status]}
        {task.dueDate ? ` · Due ${task.dueDate}` : ""}
        {task.notes ? ` · ${task.notes}` : ""}
      </span>
    )
  } catch {
    return <span>Task added.</span>
  }
}
function ChangeComparison({
  input,
  current,
}: {
  input: ObjectMutation
  current?: Checklist
}) {
  const rows: { label: string; saved: unknown; draft: unknown }[] = []
  if (input.action.type === "create")
    rows.push({
      label: "Checklist title",
      saved: current?.title,
      draft: input.action.title,
    })
  else
    for (const change of input.action.changes) {
      if (change.type === "add_task")
        rows.push({
          label: "Add task",
          saved: current?.tasks.find((task) => task.id === change.task.id)
            ?.title,
          draft: change.task.title,
        })
      else if (change.type === "archive")
        rows.push({
          label: "Archived",
          saved: current?.archived,
          draft: change.archived,
        })
      else if (change.type === "edit") {
        if (change.title !== undefined)
          rows.push({
            label: "Checklist title",
            saved: current?.title,
            draft: change.title,
          })
        if (change.notes !== undefined)
          rows.push({
            label: "Checklist notes",
            saved: current?.notes,
            draft: change.notes,
          })
      } else {
        const task = current?.tasks.find((item) => item.id === change.taskId)
        for (const key of Object.keys(
          change.patch
        ) as (keyof typeof change.patch)[])
          rows.push({
            label: `${task?.title ?? "Task"} · ${fieldLabel(key)}`,
            saved: task?.[key],
            draft: change.patch[key],
          })
      }
    }
  return (
    <div className="checklist-comparisons">
      {rows.map((row, index) => (
        <div key={index} className="checklist-comparison">
          <h3>{row.label}</h3>
          <dl>
            <div>
              <dt>Your draft</dt>
              <dd>{displayValue(row.draft)}</dd>
            </div>
            <div>
              <dt>Latest saved</dt>
              <dd>{displayValue(row.saved)}</dd>
            </div>
          </dl>
        </div>
      ))}
    </div>
  )
}
