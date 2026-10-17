import { Link } from "@tanstack/react-router"
import { ArrowLeft, ListTodo, Plus } from "lucide-react"
import { useEffect, useId, useState } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { parseAgentId, workspaceDestination } from "@/navigation/workspace"

import { ChecklistView, SaveState } from "./checklist"
import { useObjects, useObjectState } from "./context"

export function ObjectsWorkbench({
  selected,
  onSelect,
  onEditing,
}: {
  selected: string | null
  onSelect: (id: string | null) => void
  onEditing: (editing: boolean) => void
}) {
  const context = useObjects()
  if (!context) return null
  return <Workbench {...{ selected, onSelect, onEditing, context }} />
}
function Workbench({
  selected,
  onSelect,
  onEditing,
  context,
}: {
  selected: string | null
  onSelect: (id: string | null) => void
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
          <h2 className="workbench-section-title flex items-center gap-2">
            <ListTodo className="size-4" /> Checklists
          </h2>
          {!creating && (
            <Button
              variant="outline"
              size="sm"
              disabled={archived || locked}
              onClick={() => setCreating(crypto.randomUUID())}
            >
              <Plus data-icon="inline-start" />
              New checklist
            </Button>
          )}
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
            All checklists
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
                  autoFocus
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
              <Button type="submit" disabled={!!state.pending[creating]}>
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
                  <EmptyTitle>No checklists yet</EmptyTitle>
                  <EmptyDescription>
                    Create a checklist or ask your agent to plan a project.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
            {state.list
              .filter((object) => !object.archived)
              .map((object) => (
                <Link
                  key={object.id}
                  className={buttonVariants({
                    variant: "ghost",
                    className:
                      "h-auto min-h-16 w-full justify-start gap-3 border-b px-0 py-3",
                  })}
                  disabled={editing}
                  {...workspaceDestination(parseAgentId(agentId), {
                    panel: "objects",
                    item: object.id,
                  })}
                >
                  <ListTodo data-icon="inline-start" />
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate">{object.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {object.completed} of {object.total} complete
                    </span>
                  </span>
                  <Badge variant="secondary">r{object.revision}</Badge>
                </Link>
              ))}
            {state.list.some((object) => object.archived) && (
              <details>
                <summary className="cursor-pointer text-sm text-muted-foreground">
                  Archived checklists
                </summary>
                {state.list
                  .filter((object) => object.archived)
                  .map((object) => (
                    <Link
                      key={object.id}
                      className={buttonVariants({
                        variant: "ghost",
                        className: "mt-2 h-auto w-full justify-start py-3",
                      })}
                      {...workspaceDestination(parseAgentId(agentId), {
                        panel: "objects",
                        item: object.id,
                      })}
                    >
                      {object.title}
                    </Link>
                  ))}
              </details>
            )}
          </>
        )}
      </div>
    </>
  )
}
