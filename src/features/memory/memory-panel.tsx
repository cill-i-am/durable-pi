import { useEffect, useMemo, useState } from "react"
import { BookOpen, Search } from "lucide-react"
import { agentApi, agentUrl } from "@/http/client"
import type { ChatState } from "@/conversations/contracts"
import { Markdown } from "@/components/markdown"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
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
  SheetTrigger,
} from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

export function MemoryPanel({
  state,
  agentId,
}: {
  state: ChatState | null
  agentId: string
}) {
  const api = agentApi(agentId)
  const [query, setQuery] = useState(""),
    [results, setResults] = useState<
      { id: number; text: string; kind: string; date: string }[]
    >([]),
    [error, setError] = useState("")
  async function search(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    try {
      setResults(await api(`search?q=${encodeURIComponent(query)}`))
      setError("")
    } catch {
      setError("Could not search memory.")
    }
  }
  return (
    <Sheet>
      <SheetTrigger render={<Button variant="ghost" size="sm" />}>
        <BookOpen data-icon="inline-start" />
        Memory
      </SheetTrigger>
      <SheetContent className="memory-sheet">
        <SheetHeader>
          <SheetTitle>What stays with me</SheetTitle>
          <SheetDescription>
            {state?.memory.messages ?? 0} archived messages ·{" "}
            {state?.memory.notes.length ?? 0} memory notes
          </SheetDescription>
        </SheetHeader>
        <Tabs defaultValue="notes">
          <TabsList>
            <TabsTrigger value="notes">Notes</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
            <TabsTrigger value="tree">Tree</TabsTrigger>
            <TabsTrigger value="files">Files</TabsTrigger>
          </TabsList>
          <TabsContent value="notes">
            <div className="memory-notes">
              {state?.memory.notes.length ? (
                state.memory.notes.map((note) => (
                  <article key={note.path}>
                    <h3>{note.path}</h3>
                    <Markdown text={note.body} />
                    <small>Source: message {note.source_id}</small>
                  </article>
                ))
              ) : (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>Nothing saved yet</EmptyTitle>
                    <EmptyDescription>
                      Preferences and useful facts will appear here as your
                      conversation grows.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </div>
          </TabsContent>
          <TabsContent value="history">
            <form onSubmit={search} className="memory-search">
              <Field>
                <FieldLabel htmlFor="memory-search">
                  Search the archive
                </FieldLabel>
                <div className="flex gap-2">
                  <Input
                    id="memory-search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="A name, decision, or phrase…"
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
            {error && (
              <Alert>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="memory-notes">
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
            <MemoryFiles memory={state?.memory} agentId={agentId} />
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}

type TreePart = { start: number; count: number; text: string }
type TreeBranch = {
  children: TreePart[]
  original: { kind: string; text: string; date: string } | null
}
function MemoryTree({ agentId }: { agentId: string }) {
  const api = useMemo(() => agentApi(agentId), [agentId])
  const [parts, setParts] = useState<TreePart[]>([]),
    [trail, setTrail] = useState<TreePart[]>([]),
    [original, setOriginal] = useState<TreeBranch["original"]>(null),
    [pending, setPending] = useState(false),
    [error, setError] = useState("")
  useEffect(() => {
    const controller = new AbortController()
    setPending(true)
    api<TreePart[]>("tree", undefined, controller.signal)
      .then(setParts)
      .catch(() => {
        if (!controller.signal.aborted) setError("Could not load memory.")
      })
      .finally(() => {
        if (!controller.signal.aborted) setPending(false)
      })
    return () => controller.abort()
  }, [api])
  async function open(next: TreePart[]) {
    setPending(true)
    setError("")
    try {
      const part = next.at(-1)
      if (part) {
        const branch = await api<TreeBranch>(
          `tree?id=${part.start}&n=${part.count}`
        )
        setParts(branch.children)
        setOriginal(branch.original)
      } else {
        setParts(await api<TreePart[]>("tree"))
        setOriginal(null)
      }
      setTrail(next)
    } catch {
      setError("This part of memory is not ready yet. Try again shortly.")
    } finally {
      setPending(false)
    }
  }
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
}: {
  memory: ChatState["memory"] | undefined
  agentId: string
}) {
  const api = agentApi(agentId)
  const [file, setFile] = useState<File | null>(null),
    [pending, setPending] = useState(false),
    [status, setStatus] = useState("")
  async function upload(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!file) return
    setPending(true)
    setStatus("")
    try {
      if (file.size > 1_000_000)
        throw new Error("Choose a file smaller than 1 MB.")
      const result = await api<{ added: number }>("import", {
        jsonl: await file.text(),
      })
      setStatus(
        `${result.added} messages imported. Their summaries will build in the background.`
      )
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Could not import history."
      )
    } finally {
      setPending(false)
    }
  }
  return (
    <div className="memory-notes">
      <article>
        <h3>Download your memory</h3>
        <p className="text-sm text-muted-foreground">
          Includes original messages, the summary tree, and note revisions. Keep
          downloaded files private.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={
              <a href={agentUrl(agentId, "export?format=html")} download />
            }
          >
            Readable HTML
          </Button>
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<a href={agentUrl(agentId, "export")} download />}
          >
            Archive JSONL
          </Button>
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
      </article>
      <article>
        <h3>Import older history</h3>
        <form onSubmit={upload}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="history-file">Messages file</FieldLabel>
              <Input
                id="history-file"
                type="file"
                accept=".jsonl,.ndjson"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
              <FieldDescription>
                One JSON object per line with kind, text, and an ISO date. Up to
                200 messages and 1 MB per file. Imported text becomes history;
                it does not start a reply.
              </FieldDescription>
            </Field>
            <Button type="submit" variant="outline" disabled={!file || pending}>
              {pending ? "Importing…" : "Import history"}
            </Button>
          </FieldGroup>
        </form>
        {status && (
          <Alert>
            <AlertDescription>{status}</AlertDescription>
          </Alert>
        )}
      </article>
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
