import { Search, ChevronDown } from "lucide-react"
import { useMemo, useState } from "react"

import { Markdown } from "@/components/markdown"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { ChatState } from "@/conversations/contracts"
import { agentUrl } from "@/http/client"

import { BackupRecovery } from "./backup-recovery"
import { MemoryImport } from "./memory-import"
import type { MemoryQuery } from "./query.machine"
import { SummaryRecovery } from "./summary-recovery"
import { useMemoryQuery } from "./use-memory-query"

export function MemoryWorkbench({
  state,
  agentId,
  refresh,
  tab,
  onTabChange: setTab,
  query,
  onQueryChange: setQuery,
}: {
  query: string
  onQueryChange: (query: string) => void
  tab: "notes" | "history" | "tree" | "files"
  onTabChange: (tab: "notes" | "history" | "tree" | "files") => void
  state: ChatState | null
  refresh: () => void
  agentId: string
}) {
  const request = useMemo<MemoryQuery | null>(
    () =>
      tab === "history" && query.trim() ? { kind: "search", query } : null,
    [tab, query]
  )
  const searchQuery = useMemoryQuery(agentId, request)
  const results = searchQuery.data.results
  const error = searchQuery.error
  const loading = searchQuery.pending
  function search(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setTab("history")
  }
  return (
    <section className="workbench-body memory-workbench">
      <header className="workbench-heading">
        <h2 className="workbench-title">Memory</h2>
        <p>
          {state?.memory.messages ?? 0} archived messages ·{" "}
          {state?.memory.notes.length ?? 0} memory notes
        </p>
      </header>
      <SummaryRecovery
        agentId={agentId}
        issues={state?.memory.issues ?? []}
        recovery={state?.memory.compactionRecovery}
        refresh={refresh}
      />
      <form onSubmit={search} className="memory-search">
        <Field>
          <FieldLabel htmlFor="memory-search" className="sr-only">
            Search the archive
          </FieldLabel>
          <div className="flex gap-2">
            <Input
              id="memory-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search conversation history…"
              maxLength={500}
            />
            <Button
              type="submit"
              variant="outline"
              size="icon"
              aria-label="Search memory"
              disabled={!query.trim()}
            >
              <Search />
            </Button>
          </div>
        </Field>
      </form>
      <Tabs
        value={tab}
        onValueChange={(value: unknown) => {
          if (
            value === "notes" ||
            value === "history" ||
            value === "tree" ||
            value === "files"
          )
            setTab(value)
        }}
      >
        <TabsList
          variant="line"
          className="h-auto max-w-full flex-wrap justify-start group-data-horizontal/tabs:h-auto"
        >
          <TabsTrigger value="notes" className="min-h-11 md:min-h-0">
            Saved notes
          </TabsTrigger>
          <TabsTrigger value="history" className="min-h-11 md:min-h-0">
            History
          </TabsTrigger>
          <TabsTrigger value="tree" className="min-h-11 md:min-h-0">
            Summaries
          </TabsTrigger>
          <TabsTrigger value="files" className="min-h-11 md:min-h-0">
            Export & import
          </TabsTrigger>
        </TabsList>
        <TabsContent value="notes">
          <div className="memory-notes">
            {state?.memory.notes.length ? (
              state.memory.notes.map((note) => (
                <MemoryNote key={note.path} note={note} agentId={agentId} />
              ))
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No saved notes</EmptyTitle>
                  <EmptyDescription>
                    Ask your agent to save a preference or useful fact.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </div>
        </TabsContent>
        <TabsContent value="history">
          {error && (
            <Alert>
              <AlertDescription>
                {error}
                <Button variant="link" size="sm" onClick={searchQuery.retry}>
                  Retry search
                </Button>
              </AlertDescription>
            </Alert>
          )}
          <div className="memory-notes">
            <p role="status" className="text-sm text-muted-foreground">
              {loading
                ? "Searching…"
                : !query.trim()
                  ? "Search for a message or phrase."
                  : !error && !results.length
                    ? "No matching messages."
                    : ""}
            </p>
            {!loading && !error && query.trim() && !results.length && (
              <Button variant="outline" size="sm" onClick={() => setQuery("")}>
                Clear search
              </Button>
            )}
            {results.map((result) => (
              <article key={result.id}>
                <h3>
                  {result.kind} · message {result.id}
                </h3>
                <p className="message-text">{result.text}</p>
              </article>
            ))}
          </div>
        </TabsContent>
        <TabsContent value="tree">
          <MemoryTree agentId={agentId} />
        </TabsContent>
        <TabsContent value="files">
          <MemoryFiles
            memory={state?.memory}
            agentId={agentId}
            refresh={refresh}
          />
        </TabsContent>
      </Tabs>
    </section>
  )
}

function MemoryNote({
  note,
  agentId,
}: {
  note: ChatState["memory"]["notes"][number]
  agentId: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <article className="memory-note">
      <h3>{note.path}</h3>
      <Markdown text={note.body} />
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
          <ChevronDown data-icon="inline-start" />
          Source · message {note.source_id}
        </CollapsibleTrigger>
        <CollapsibleContent>
          {open && (
            <NoteSource
              key={note.source_id}
              agentId={agentId}
              source={note.source_id}
            />
          )}
        </CollapsibleContent>
      </Collapsible>
    </article>
  )
}

function NoteSource({ agentId, source }: { agentId: string; source: number }) {
  const request = useMemo<MemoryQuery>(
    () => ({ kind: "source", source }),
    [source]
  )
  const sourceQuery = useMemoryQuery(agentId, request)
  const original = sourceQuery.data.original
  const error = sourceQuery.error
  return (
    <div className="memory-source">
      {error ? (
        <>
          <p role="alert">{error}</p>
          <Button variant="outline" size="xs" onClick={sourceQuery.retry}>
            Retry source
          </Button>
        </>
      ) : original ? (
        <>
          <p className="text-xs text-muted-foreground">
            Original {original.kind} ·{" "}
            {new Date(original.date).toLocaleString()}
          </p>
          <p className="message-text">{original.text}</p>
        </>
      ) : (
        <p role="status">Loading source…</p>
      )}
    </div>
  )
}

function MemoryTree({ agentId }: { agentId: string }) {
  const request = useMemo<MemoryQuery>(
    () => ({ kind: "tree", trail: [], initial: true }),
    []
  )
  const treeQuery = useMemoryQuery(agentId, request)
  const parts = treeQuery.data.parts
  const trail = treeQuery.data.trail
  const original = treeQuery.data.original
  const pending = treeQuery.pending
  const error = treeQuery.error
  const open = treeQuery.open
  const selected = trail.at(-1)
  return (
    <div className="memory-notes">
      <p className="text-sm text-muted-foreground">
        Open a summary to see its two children, then the original message.
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => void open([])}
        >
          Current view
        </Button>
        {selected && (
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => void open(trail.slice(0, -1))}
          >
            Back
          </Button>
        )}
      </div>
      {error && (
        <Alert>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {pending && <Skeleton className="h-16 w-full" />}
      {selected && (
        <article>
          <h3>
            {selected.start}+{selected.count} · {selected.count}{" "}
            {selected.count === 1 ? "message" : "messages"}
          </h3>
          <p className="message-text">{selected.text}</p>
        </article>
      )}
      {original ? (
        <article>
          <h3>Original · {original.kind}</h3>
          <small>{new Date(original.date).toLocaleString()}</small>
          <p className="message-text">{original.text}</p>
        </article>
      ) : (
        parts.map((part) => (
          <article key={`${part.start}+${part.count}`}>
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => void open([...trail, part])}
            >
              Open {part.start}+{part.count}
            </Button>
            <p className="message-text">{part.text}</p>
          </article>
        ))
      )}
      {!pending && !parts.length && !original && (
        <p>No archived messages yet.</p>
      )}
    </div>
  )
}
function MemoryFiles({
  memory,
  agentId,
  refresh,
}: {
  memory: ChatState["memory"] | undefined
  refresh: () => void
  agentId: string
}) {
  return (
    <div className="memory-notes">
      <article>
        <h3>Download your memory</h3>
        <p className="text-sm text-muted-foreground">
          Includes original messages, the summary tree, and note revisions. Keep
          downloaded files private.
        </p>
        <div className="flex flex-wrap gap-2">
          <a
            href={agentUrl(agentId, "export?format=html")}
            download
            data-slot="button"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Readable HTML
          </a>
          <a
            href={agentUrl(agentId, "export")}
            download
            data-slot="button"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Archive JSONL
          </a>
        </div>
      </article>
      <article>
        <h3>Cloud backup</h3>
        <p className="text-sm text-muted-foreground">
          {memory?.backup?.error ??
            (memory?.backup?.date
              ? `Last complete backup: ${new Date(memory.backup.date).toLocaleString()}`
              : "Waiting for the first backup.")}
        </p>
        <BackupRecovery
          agentId={agentId}
          recovery={memory?.backup?.recovery ?? null}
          schedulerRecovery={memory?.backup?.schedulerRecovery ?? null}
          refresh={refresh}
        />
      </article>
      <MemoryImport key={agentId} agentId={agentId} refresh={refresh} />
      {!!memory?.usage?.requests && (
        <article>
          <h3>Model cache</h3>
          <p className="text-sm text-muted-foreground">
            {memory.usage.cached.toLocaleString()} of{" "}
            {memory.usage.input.toLocaleString()} input tokens read from cache
            across {memory.usage.requests.toLocaleString()} requests.
          </p>
        </article>
      )}
    </div>
  )
}
