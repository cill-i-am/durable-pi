import { useCallback, useEffect, useRef, useState } from "react"
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
  PanelsTopLeft,
  Plus,
  ArrowLeft,
  Globe,
  TerminalSquare,
  Files,
} from "lucide-react"

export function AppsWorkbench({
  agentId,
  agentName,
  onPendingChange,
  onOpenWorkbench,
}: {
  agentId: string
  agentName: string
  onOpenWorkbench: (value: "browser" | "terminal" | "files") => void
  onPendingChange: (pending: boolean) => void
}) {
  const [apps, setApps] = useState<AppDocument[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [creating, setCreating] = useState(false),
    [error, setError] = useState("")
  const [creationPending, setCreationPending] = useState(false)
  useEffect(() => {
    onPendingChange(creationPending)
    return () => onPendingChange(false)
  }, [creationPending, onPendingChange])
  const creationGeneration = useRef(0)
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
  const content = (
    <>
      <header className="workbench-heading-row">
        <div className="flex items-center gap-2 text-sm font-medium">
          <PanelsTopLeft className="size-4" />
          {!apps.length && !selected && !creating ? (
            <span className="text-xs font-normal text-muted-foreground">
              YOUR WORKBENCH
            </span>
          ) : (
            <>
              Apps <Badge variant="secondary">Private</Badge>
            </>
          )}
        </div>
      </header>
      <div className="workbench-body">
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
            {!!apps.length && (
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
                  Ask this bot to build an app, or start with a checklist.
                  Published checklists and forms send their updates back to the
                  bot.
                </p>
              </>
            )}
            {!apps.length && !error && (
              <section className="workbench-welcome">
                <h2>Room for the work.</h2>
                <p>
                  The things you open, make and explore appear beside your
                  conversation.
                </p>
                <div>
                  {[
                    {
                      id: "browser",
                      title: "Browser",
                      detail: "Explore a page together.",
                      icon: Globe,
                    },
                    {
                      id: "terminal",
                      title: "Terminal",
                      detail: "See the commands behind the work.",
                      icon: TerminalSquare,
                    },
                    {
                      id: "files",
                      title: "Files & context",
                      detail: "Keep useful things close at hand.",
                      icon: Files,
                    },
                  ].map((item) => (
                    <Button
                      key={item.id}
                      variant="ghost"
                      onClick={() =>
                        onOpenWorkbench(
                          item.id as "browser" | "terminal" | "files"
                        )
                      }
                    >
                      <item.icon />
                      <span>
                        <strong>{item.title}</strong>
                        <span>{item.detail}</span>
                      </span>
                    </Button>
                  ))}
                </div>
                <Button
                  variant="outline"
                  className="workbench-create"
                  onClick={() => {
                    creationGeneration.current++
                    setCreating(true)
                  }}
                >
                  <Plus /> New checklist app
                </Button>
              </section>
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
  return content
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
