import { useCallback, useEffect, useRef, useState } from "react"
import { cn } from "cn"
import { Schema } from "effect"
import { AppDefinition, AppDocument, AppList } from "@/apps/contracts"
import { agentApi } from "@/http/client"
import { poll } from "@/http/poll"
import { AppView } from "./app-view"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
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
import { PanelsTopLeft, Plus, X, ArrowLeft } from "lucide-react"

export function AppsWorkbench({
  agentId,
  agentName,
  onClose,
}: {
  agentId: string
  agentName: string
  onClose: () => void
}) {
  const [apps, setApps] = useState<AppDocument[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [creating, setCreating] = useState(false),
    [error, setError] = useState("")
  const [creationPending, setCreationPending] = useState(false)
  const creationGeneration = useRef(0)
  const [wide, setWide] = useState(false)
  const portalContainer = useRef<HTMLDivElement>(null)
  const sequence = useRef(0)
  const refresh = useCallback(async () => {
    const generation = ++sequence.current
    try {
      const data = Schema.decodeUnknownSync(AppList)(
        await agentApi(agentId)("apps")
      )
      if (generation === sequence.current) {
        setApps([...data.apps])
        setError("")
      }
    } catch (cause) {
      if (generation === sequence.current)
        setError(
          cause instanceof Error ? cause.message : "Could not load apps."
        )
    }
  }, [agentId])
  useEffect(() => {
    const stop = poll(
      async () => {
        if (document.visibilityState === "visible") await refresh()
      },
      4000,
      true
    )
    return () => {
      stop()
      sequence.current++
    }
  }, [refresh])
  useEffect(() => {
    const media = matchMedia("(min-width: 1280px)")
    const update = () => setWide(media.matches)
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])
  const content = (
    <>
      <header className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <PanelsTopLeft className="size-4" /> Apps{" "}
          <Badge variant="secondary">Private</Badge>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Hide apps"
          disabled={creationPending}
          onClick={onClose}
        >
          <X />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
        {error && (
          <Alert>
            <AlertDescription>
              {error}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refresh()}
              >
                Retry apps
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {selected || creating ? (
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            disabled={creationPending}
            onClick={() => {
              creationGeneration.current++
              setSelected(null)
              setCreating(false)
            }}
          >
            <ArrowLeft data-icon="inline-start" /> All apps
          </Button>
        ) : null}
        {creating ? (
          <CreateChecklist
            agentId={agentId}
            onPendingChange={setCreationPending}
            onCreated={((generation: number) => (id: string) => {
              if (creationGeneration.current !== generation) return
              setSelected(id)
              setCreating(false)
              void refresh()
            })(creationGeneration.current)}
          />
        ) : selected ? (
          <AppView key={selected} agentId={agentId} id={selected} />
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-medium">Made with {agentName}</h2>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  creationGeneration.current++
                  setCreating(true)
                }}
              >
                <Plus data-icon="inline-start" /> New checklist
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Ask this bot to build an app, or start with a checklist. Published
              checklists and forms send their updates back to the bot.
            </p>
            {!apps.length && (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No apps yet</EmptyTitle>
                  <EmptyDescription>
                    Trip plans, project trackers and small forms live here.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
            {apps
              .filter((app) => !app.archived)
              .map((app) => (
                <AppRow
                  key={app.id}
                  app={app}
                  onSelect={() => setSelected(app.id)}
                />
              ))}
            {apps.some((app) => app.archived) && (
              <details>
                <summary className="cursor-pointer text-xs font-medium">
                  Archived apps
                </summary>
                <div className="mt-3 flex flex-col gap-2">
                  {apps
                    .filter((app) => app.archived)
                    .map((app) => (
                      <AppRow
                        key={app.id}
                        app={app}
                        onSelect={() => setSelected(app.id)}
                      />
                    ))}
                </div>
              </details>
            )}
          </>
        )}
      </div>
      <footer className="border-t px-4 py-3 text-xs text-muted-foreground">
        Private to {agentName}. Published versions and saved responses survive
        reconnects.
      </footer>
    </>
  )
  // A stable portal container keeps form drafts and uncertain operation IDs alive
  // when the panel changes between a desktop workbench and a mobile dialog.
  return (
    <div
      ref={portalContainer}
      className={cn(
        wide && "relative min-h-0 w-[min(48vw,720px)] shrink-0 border-l"
      )}
    >
      <Sheet
        open
        modal={!wide}
        onOpenChange={(open, event) => {
          if (
            !open &&
            !creationPending &&
            (!wide || event.reason === "escape-key")
          )
            onClose()
        }}
      >
        <SheetContent
          portalContainer={portalContainer}
          showOverlay={!wide}
          side="right"
          className={cn(
            "flex w-full max-w-full flex-col gap-0 p-0 data-[side=right]:w-full sm:max-w-xl",
            wide &&
              "absolute shadow-none data-[side=right]:w-full data-[side=right]:border-l-0 data-[side=right]:sm:max-w-none"
          )}
          showCloseButton={false}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{agentName} apps</SheetTitle>
            <SheetDescription>
              Create and use this bot's private apps.
            </SheetDescription>
          </SheetHeader>
          {content}
        </SheetContent>
      </Sheet>
    </div>
  )
}
function AppRow({ app, onSelect }: { app: AppDocument; onSelect: () => void }) {
  return (
    <Button
      variant="outline"
      className="h-auto w-full flex-col items-start gap-1 py-3 text-left"
      onClick={onSelect}
    >
      <span className="max-w-full truncate font-medium">
        {app.definition.title}
      </span>
      <span className="text-xs text-muted-foreground">
        {app.archived
          ? "Archived"
          : app.publishedVersion
            ? `Published · version ${app.publishedVersion}`
            : "Draft"}
      </span>
    </Button>
  )
}
function CreateChecklist({
  agentId,
  onCreated,
  onPendingChange,
}: {
  agentId: string
  onCreated: (id: string) => void
  onPendingChange: (pending: boolean) => void
}) {
  const [title, setTitle] = useState("Weekend plans"),
    [items, setItems] = useState(
      "Book the train\nPack bags\nCheck the forecast"
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("")
  const pending = useRef<{
      operationId: string
      id: string
      expectedRevision: number
      definition: AppDefinition
    } | null>(null),
    lock = useRef(false)
  const [uncertain, setUncertain] = useState(false)
  async function submit() {
    if (lock.current) return
    lock.current = true
    onPendingChange(true)
    setBusy(true)
    setError("")
    try {
      if (!pending.current) {
        const definition = Schema.decodeUnknownSync(AppDefinition)({
          title,
          description: "",
          blocks: [
            {
              id: "tasks",
              type: "checklist",
              title: "To do",
              items: items
                .split("\n")
                .map((value) => value.trim())
                .filter(Boolean)
                .map((label, i) => ({ id: `item_${i + 1}`, label })),
            },
          ],
        })
        pending.current = {
          operationId: crypto.randomUUID(),
          id: crypto.randomUUID(),
          expectedRevision: 0,
          definition,
        }
      }
      const app = Schema.decodeUnknownSync(AppDocument)(
        await agentApi(agentId)("apps/save", pending.current)
      )
      pending.current = null
      setUncertain(false)
      onCreated(app.id)
    } catch (cause) {
      setUncertain(!!pending.current)
      setError(
        pending.current
          ? cause instanceof Error
            ? cause.message
            : "Save is unconfirmed. Retry the same draft."
          : "Enter a title and between 1 and 40 checklist items, each up to 200 characters."
      )
    } finally {
      lock.current = false
      onPendingChange(!!pending.current)
      setBusy(false)
    }
  }
  async function cancel() {
    if (!pending.current || lock.current) return
    lock.current = true
    onPendingChange(true)
    setBusy(true)
    try {
      const response = await agentApi(agentId)<{ applied: boolean }>(
        "apps/cancel",
        { operationId: pending.current.operationId }
      )
      if (response.applied) {
        const id = pending.current.id
        pending.current = null
        onCreated(id)
      } else {
        pending.current = null
        setUncertain(false)
        setError("")
      }
    } catch {
      setError("Could not resolve the saved draft. Retry.")
    } finally {
      lock.current = false
      onPendingChange(!!pending.current)
      setBusy(false)
    }
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="app-title">Checklist name</FieldLabel>
          <Input
            id="app-title"
            value={title}
            maxLength={80}
            required
            disabled={busy || uncertain}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="app-items">One item per line</FieldLabel>
          <Textarea
            id="app-items"
            value={items}
            maxLength={8040}
            required
            disabled={busy || uncertain}
            onChange={(event) => setItems(event.target.value)}
            className="min-h-40"
          />
        </Field>
        {error && (
          <Alert>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button type="submit" disabled={busy}>
          {uncertain ? "Retry draft" : "Create draft"}
        </Button>
        {uncertain && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void cancel()}
          >
            Resolve and edit
          </Button>
        )}
        <p className="text-xs text-muted-foreground">
          Preview the draft before publishing it privately.
        </p>
      </FieldGroup>
    </form>
  )
}
