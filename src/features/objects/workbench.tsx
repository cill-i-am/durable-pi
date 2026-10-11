import { useEffect, useId, useState } from "react"
import { ArrowLeft, ListTodo, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty"
import { ChecklistView, SaveState } from "./checklist"
import { useObjects, useObjectState } from "./context"

export function ObjectsWorkbench({
  selected,
  onSelect,
  agentName,
  onEditing,
}: {
  selected: string | null
  onSelect: (id: string | null) => void
  agentName: string
  onEditing: (editing: boolean) => void
}) {
  const context = useObjects()
  if (!context) return null
  return (
    <Workbench {...{ selected, onSelect, agentName, onEditing, context }} />
  )
}
function Workbench({
  selected,
  onSelect,
  agentName,
  onEditing,
  context,
}: {
  selected: string | null
  onSelect: (id: string | null) => void
  agentName: string
  onEditing: (editing: boolean) => void
  context: NonNullable<ReturnType<typeof useObjects>>
}) {
  const { store, agentId, archived } = context,
    state = useObjectState(store)
  const [editing, setEditing] = useState(false),
    [creating, setCreating] = useState<string | null>(null),
    [title, setTitle] = useState("")
  const inputId = useId(),
    locked = editing || !!creating || Object.keys(state.pending).length > 0
  useEffect(() => {
    onEditing(editing || !!creating)
    return () => onEditing(false)
  }, [editing, creating, onEditing])
  useEffect(() => {
    if (creating && state.saved[creating]) {
      onSelect(creating)
      setCreating(null)
      setTitle("")
    }
  }, [state.saved, creating, onSelect])
  return (
    <>
      {!selected && (
        <header className="workbench-heading-row">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ListTodo className="size-4" /> Objects
            <Badge variant="secondary">Private</Badge>
          </div>
        </header>
      )}
      <div className="workbench-body objects-workbench-body">
        {state.error && (
          <Alert>
            <AlertDescription>
              {state.error}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void store.refresh()}
              >
                Reconnect
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {(selected || creating) && (
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            disabled={editing || !!creating}
            onClick={() => onSelect(null)}
          >
            <ArrowLeft data-icon="inline-start" />
            All objects
          </Button>
        )}
        {selected ? (
          <ChecklistView
            key={selected}
            id={selected}
            store={store}
            agentId={agentId}
            archived={archived}
            onEditing={setEditing}
          />
        ) : creating ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              void store.submit({
                id: creating,
                operationId: crypto.randomUUID(),
                expectedRevision: 0,
                action: { type: "create", title, notes: "", tasks: [] },
              })
            }}
          >
            <h2 className="text-xl font-semibold">New project checklist</h2>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={inputId}>Project title</FieldLabel>
                <Input
                  id={inputId}
                  required
                  maxLength={120}
                  value={title}
                  disabled={!!state.pending[creating]}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </Field>
            </FieldGroup>
            {(state.problems[creating] || state.pending[creating]) && (
              <SaveState store={store} id={creating} />
            )}
            <div className="flex gap-2">
              <Button
                type="submit"
                disabled={!!state.pending[creating] || !title.trim()}
              >
                Create checklist
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!!state.pending[creating]}
                onClick={() => {
                  store.dismiss(creating)
                  setCreating(null)
                  setTitle("")
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-medium">Made with {agentName}</h2>
              <Button
                variant="outline"
                size="sm"
                disabled={archived || locked}
                onClick={() => setCreating(crypto.randomUUID())}
              >
                <Plus data-icon="inline-start" />
                New checklist
              </Button>
            </div>
            {Object.values(state.pending)
              .filter(
                (input) => !state.list.some((item) => item.id === input.id)
              )
              .map((input) => (
                <section key={input.id}>
                  <h3 className="mb-2 text-sm font-medium">
                    Unconfirmed checklist
                  </h3>
                  <SaveState store={store} id={input.id} />
                </section>
              ))}
            {!state.list.length && (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>Keep the work here</EmptyTitle>
                  <EmptyDescription>
                    Ask {agentName} to plan a project, or start a checklist.
                    Tasks, notes and history stay available beyond the
                    conversation.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
            {state.list
              .filter((object) => !object.archived)
              .map((object) => (
                <Button
                  key={object.id}
                  variant="ghost"
                  className="h-auto min-h-16 w-full justify-start gap-3 border-b px-0 py-3"
                  disabled={editing}
                  onClick={() => onSelect(object.id)}
                >
                  <ListTodo data-icon="inline-start" />
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate">{object.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {object.completed} of {object.total} complete
                    </span>
                  </span>
                  <Badge variant="secondary">r{object.revision}</Badge>
                </Button>
              ))}
            {state.list.some((object) => object.archived) && (
              <details>
                <summary className="cursor-pointer text-sm text-muted-foreground">
                  Archived checklists
                </summary>
                {state.list
                  .filter((object) => object.archived)
                  .map((object) => (
                    <Button
                      key={object.id}
                      variant="ghost"
                      className="mt-2 h-auto w-full justify-start py-3"
                      onClick={() => onSelect(object.id)}
                    >
                      {object.title}
                    </Button>
                  ))}
              </details>
            )}
          </>
        )}
      </div>
      <footer className="border-t px-4 py-3 text-xs text-muted-foreground">
        Private to {agentName}. Saved tasks and history survive reconnects.
      </footer>
    </>
  )
}
