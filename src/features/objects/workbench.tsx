import { useEffect, useId, useRef, useState } from "react"
import { cn } from "cn"
import { ArrowLeft, ListTodo, Plus, X } from "lucide-react"
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
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { ChecklistView, SaveState } from "./checklist"
import { useObjects, useObjectState } from "./context"

export function ObjectsWorkbench({
  selected,
  onSelect,
  agentName,
  onClose,
  onEditing,
}: {
  selected: string | null
  onSelect: (id: string | null) => void
  agentName: string
  onClose: () => void
  onEditing: (editing: boolean) => void
}) {
  const context = useObjects()
  if (!context) return null
  return (
    <Workbench
      {...{ selected, onSelect, agentName, onClose, onEditing, context }}
    />
  )
}
function Workbench({
  selected,
  onSelect,
  agentName,
  onClose,
  onEditing,
  context,
}: {
  selected: string | null
  onSelect: (id: string | null) => void
  agentName: string
  onClose: () => void
  onEditing: (editing: boolean) => void
  context: NonNullable<ReturnType<typeof useObjects>>
}) {
  const { store, agentId, archived } = context,
    state = useObjectState(store)
  const [wide, setWide] = useState(false),
    [editing, setEditing] = useState(false),
    [creating, setCreating] = useState<string | null>(null),
    [title, setTitle] = useState("")
  const container = useRef<HTMLDivElement>(null),
    inputId = useId(),
    locked = editing || !!creating || Object.keys(state.pending).length > 0
  useEffect(() => {
    const media = matchMedia("(min-width: 1280px)")
    const update = () => setWide(media.matches)
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])
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
    <div
      ref={container}
      className={cn(
        wide && "relative min-h-0 w-[min(48vw,720px)] shrink-0 border-l"
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
          portalContainer={container}
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
            <SheetTitle>{agentName} working objects</SheetTitle>
            <SheetDescription>
              Private checklists shared between you and this bot.
            </SheetDescription>
          </SheetHeader>
          <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <ListTodo className="size-4" /> Objects
              <Badge variant="secondary">Private</Badge>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Hide objects"
              disabled={locked}
              onClick={onClose}
            >
              <X />
            </Button>
          </header>
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4 sm:p-6">
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
        </SheetContent>
      </Sheet>
    </div>
  )
}
