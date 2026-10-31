import { Link } from "@tanstack/react-router"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { DataLoading } from "@workspace/ui/components/data-loading"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@workspace/ui/components/empty"
import { Field, FieldGroup, FieldLabel } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { ArrowLeft, ChevronRight, ListTodo, Plus } from "lucide-react"
import { useEffect, useId, useState } from "react"

import { parseAgentId, workspaceDestination } from "@/navigation/workspace"

import { ChecklistView, SaveState } from "./checklist"
import { useObjects, useObjectState } from "./context"
import { useObjectCreation } from "./use-object-creation"

import "./checklist.css"

export function ObjectsWorkbench({
  selected,
  onSelect,
  onEditing,
  active = true,
}: {
  selected: string | null
  onSelect: (id: string | null) => void
  onEditing: (editing: boolean) => void
  active?: boolean
}) {
  const context = useObjects()
  if (!context) return null
  return (
    <Workbench
      key={context.agentId}
      {...{ selected, onSelect, onEditing, context, active }}
    />
  )
}
function Workbench({
  selected,
  onSelect,
  onEditing,
  context,
  active,
}: {
  selected: string | null
  onSelect: (id: string | null) => void
  onEditing: (editing: boolean) => void
  context: NonNullable<ReturnType<typeof useObjects>>
  active: boolean
}) {
  const { store, agentId, archived } = context,
    state = useObjectState(store)
  const [editing, setEditing] = useState(false),
    [title, setTitle] = useState("")
  const creation = useObjectCreation(store, selected, onSelect),
    creating = creation.id
  const inputId = useId(),
    locked = editing || !!creating || Object.keys(state.pending).length > 0
  useEffect(() => {
    onEditing(editing || !!creating)
    return () => onEditing(false)
  }, [editing, creating, onEditing])
  return (
    <section className="objects-surface">
      {!selected && (
        <header className="workbench-heading-row">
          <h2 className="workbench-section-title">Checklists</h2>
          {!creating && (
            <Button
              variant="outline"
              size="sm"
              disabled={archived || locked}
              onClick={() => {
                setTitle("")
                creation.begin()
              }}
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
            active={active}
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
            <h2 className="text-sheet font-semibold">New checklist</h2>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={inputId}>Title</FieldLabel>
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
                  void store.dismiss(creating).then((ok) => {
                    if (ok) creation.cancel()
                  })
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
            {!state.loaded && !state.error && (
              <DataLoading loading label="Loading checklists" />
            )}
            {state.loaded && !state.error && !state.list.length && (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No checklists yet</EmptyTitle>
                  <EmptyDescription>
                    Create a checklist or ask your assistant.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
            {state.list
              .filter((object) => !object.archived)
              .map((object) => (
                <Link
                  data-slot="button"
                  key={object.id}
                  className={buttonVariants({
                    variant: "ghost",
                    className: "checklist-list-row",
                  })}
                  disabled={editing}
                  {...workspaceDestination(parseAgentId(agentId), {
                    panel: "objects",
                    item: object.id,
                  })}
                >
                  <ListTodo data-icon="inline-start" />
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block break-words">{object.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {object.completed} of {object.total} complete
                    </span>
                  </span>
                  <ChevronRight className="text-muted-foreground" />
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
    </section>
  )
}
