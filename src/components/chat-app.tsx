import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { useEffect, useRef, useState } from "react"
import {
  ArrowUp,
  BookOpen,
  Check,
  LogOut,
  Search,
  Square,
  Sparkles,
  LockKeyhole,
  Copy,
  RefreshCw,
} from "lucide-react"
import { authClient } from "@/auth/client"
import type { ChatState } from "@/shared/contracts"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
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
import {
  InputGroup,
  InputGroupTextarea,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
} from "@/components/ui/input-group"
import {
  Message,
  MessageContent,
  MessageHeader,
  MessageFooter,
} from "@/components/ui/message"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
} from "@/components/ui/message-scroller"

function errorMessage(value: unknown) {
  return typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
    ? value.error
    : "The request failed."
}
async function api<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal
): Promise<T> {
  const response = await fetch(`/api/agent/${path}`, {
    method: body ? "POST" : "GET",
    signal,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) {
    if (response.status === 401)
      throw new Error("Your session has expired. Sign in again.")
    const error = await response
      .json()
      .catch(() => ({ error: "Connection interrupted. Please retry." }))
    throw new Error(errorMessage(error))
  }
  return response.json()
}
export function ChatApp() {
  const { data: session, isPending, error } = authClient.useSession()
  if (isPending)
    return (
      <main className="loading-view">
        <PiMark />
        <Skeleton className="h-4 w-40" />
        <span className="sr-only">Loading your session</span>
      </main>
    )
  if (!session) return <Login sessionError={error?.message} />
  return <Chat key={session.user.id} name={session.user.name} />
}
function PiMark() {
  return (
    <span className="pi-mark" aria-label="Pi">
      π
    </span>
  )
}
function Login({ sessionError }: { sessionError?: string }) {
  const [setup, setSetup] = useState(false),
    [error, setError] = useState(sessionError ?? ""),
    [pending, setPending] = useState(false)
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")
    setPending(true)
    const data = new FormData(event.currentTarget)
    try {
      if (setup) {
        const response = await fetch("/api/setup", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-setup-token": String(data.get("setupToken")),
          },
          body: JSON.stringify({
            name: data.get("name"),
            password: data.get("password"),
          }),
        })
        if (!response.ok) throw new Error(errorMessage(await response.json()))
        setSetup(false)
        setError("Account created. Sign in with your owner email and password.")
      } else {
        const result = await authClient.signIn.email({
          email: String(data.get("email")),
          password: String(data.get("password")),
        })
        if (result.error)
          throw new Error(result.error.message ?? "Could not sign in")
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not sign in")
    } finally {
      setPending(false)
    }
  }
  return (
    <main className="login-page">
      <div className="login-brand">
        <PiMark />
        <span>Pi</span>
        <span className="login-caption">A little more continuity.</span>
      </div>
      <section className="login-panel">
        <LockKeyhole className="login-lock" />
        <h1>{setup ? "Make yourself at home." : "Welcome back."}</h1>
        <p className="text-muted-foreground">
          {setup
            ? "Create the single owner account using your private setup key."
            : "Sign in to your private, continuous chat."}
        </p>
        <form onSubmit={submit}>
          <FieldGroup>
            {setup ? (
              <>
                <Field>
                  <FieldLabel htmlFor="name">Your name</FieldLabel>
                  <Input
                    id="name"
                    name="name"
                    autoComplete="name"
                    required
                    maxLength={100}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="setupToken">Setup key</FieldLabel>
                  <Input
                    id="setupToken"
                    name="setupToken"
                    type="password"
                    autoComplete="off"
                    required
                  />
                  <FieldDescription>
                    From your private deployment configuration.
                  </FieldDescription>
                </Field>
              </>
            ) : (
              <Field>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  placeholder="you@example.com"
                  required
                />
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="password">Password</FieldLabel>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete={setup ? "new-password" : "current-password"}
                minLength={12}
                maxLength={128}
                required
              />
            </Field>
            {error && (
              <Alert>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" disabled={pending}>
              {pending
                ? "Please wait…"
                : setup
                  ? "Create owner account"
                  : "Sign in"}
              <ArrowUp data-icon="inline-end" />
            </Button>
          </FieldGroup>
        </form>
        <Button
          variant="link"
          size="sm"
          onClick={() => {
            setSetup(!setup)
            setError("")
          }}
        >
          {setup ? "Back to sign in" : "First time? Set up your account"}
        </Button>
      </section>
      <footer className="login-footer">
        Private by default. Your conversation stays yours.
      </footer>
    </main>
  )
}
function Chat({ name }: { name: string }) {
  const [state, setState] = useState<ChatState | null>(null),
    [error, setError] = useState(""),
    [sending, setSending] = useState(false)
  const pending = useRef<{ operationId: string; text: string } | null>(null)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await api<ChatState>("state", undefined, controller.signal)
        setState(next)
        setError("")
        timer = setTimeout(
          poll,
          next.turns.some((t) =>
            ["queued", "preparing", "running"].includes(t.status)
          )
            ? 850
            : 5000
        )
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(e instanceof Error ? e.message : "Connection interrupted")
          timer = setTimeout(poll, 5000)
        }
      }
    }
    void poll()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [refresh])
  const active = state?.turns.find((t) =>
    ["preparing", "running"].includes(t.status)
  )
  async function send(text: string) {
    setSending(true)
    setError("")
    if (pending.current?.text !== text)
      pending.current = { operationId: crypto.randomUUID(), text }
    try {
      await api("send", pending.current)
      pending.current = null
      setRefresh((n) => n + 1)
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send")
      return false
    } finally {
      setSending(false)
    }
  }
  async function stop() {
    if (!active) return
    try {
      await api("cancel", { operationId: active.id })
      setRefresh((n) => n + 1)
    } catch {
      setError("Could not stop the turn. Try again.")
    }
  }
  return (
    <main className="chat-app">
      <aside className="app-rail">
        <a href="/" aria-label="Pi home">
          <PiMark />
        </a>
        <div className="rail-line" />
        <span className="rail-label">CONTINUOUS</span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Sign out"
          onClick={() => void authClient.signOut()}
        >
          <LogOut />
        </Button>
      </aside>
      <section className="chat-workspace">
        <header className="chat-header">
          <div>
            <span className="wordmark">Pi</span>
            <span className="header-subtitle">Your continuous chat</span>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline">Private</Badge>
            <MemoryPanel state={state} />
            <Button
              className="sm:hidden"
              variant="ghost"
              size="icon"
              aria-label="Sign out"
              onClick={() => void authClient.signOut()}
            >
              <LogOut />
            </Button>
          </div>
        </header>
        <MessageScrollerProvider autoScroll>
          <MessageScroller className="conversation-scroller">
            <MessageScrollerViewport>
              <MessageScrollerContent className="conversation-content">
                {!state ? (
                  <MessageScrollerItem messageId="loading">
                    <div className="flex flex-col gap-4 py-12">
                      <Skeleton className="h-6 w-48" />
                      <Skeleton className="h-4 w-72" />
                    </div>
                  </MessageScrollerItem>
                ) : state.turns.length === 0 ? (
                  <MessageScrollerItem messageId="empty">
                    <Empty className="conversation-empty">
                      <EmptyHeader>
                        <div className="empty-symbol">
                          <Sparkles />
                        </div>
                        <EmptyTitle>
                          Where shall we start, {name.split(" ")[0]}?
                        </EmptyTitle>
                        <EmptyDescription>
                          Think something through, make a plan, or tell me
                          something worth remembering.
                        </EmptyDescription>
                      </EmptyHeader>
                      <p className="empty-footnote">
                        One conversation. Room to keep going.
                      </p>
                    </Empty>
                  </MessageScrollerItem>
                ) : (
                  state.turns.flatMap((turn) => [
                    <MessageScrollerItem
                      key={`${turn.id}:user`}
                      messageId={`${turn.id}:user`}
                      scrollAnchor
                    >
                      <Message align="end">
                        <MessageContent>
                          <Bubble align="end" variant="secondary">
                            <BubbleContent className="message-text">
                              {turn.text}
                            </BubbleContent>
                          </Bubble>
                          <MessageFooter>
                            {turn.status === "queued"
                              ? "Queued"
                              : new Date(turn.created_at).toLocaleTimeString(
                                  [],
                                  { hour: "2-digit", minute: "2-digit" }
                                )}
                            {turn.status === "queued" && (
                              <Button
                                variant="ghost"
                                size="xs"
                                onClick={() =>
                                  void api("cancel", { operationId: turn.id })
                                    .then(() => setRefresh((n) => n + 1))
                                    .catch(() => setError("Could not cancel."))
                                }
                              >
                                Cancel
                              </Button>
                            )}
                          </MessageFooter>
                        </MessageContent>
                      </Message>
                    </MessageScrollerItem>,
                    <MessageScrollerItem
                      key={`${turn.id}:assistant`}
                      messageId={`${turn.id}:assistant`}
                    >
                      <Message align="start">
                        <MessageContent>
                          <MessageHeader>
                            <span className="assistant-label">Pi</span>
                          </MessageHeader>
                          <Bubble variant="ghost">
                            <BubbleContent className="message-text">
                              {turn.answer ? (
                                <Markdown text={turn.answer} />
                              ) : ["running", "preparing"].includes(
                                  turn.status
                                ) ? (
                                <span className="shimmer text-muted-foreground">
                                  {turn.status === "preparing"
                                    ? "Finding the thread…"
                                    : "Thinking…"}
                                </span>
                              ) : turn.status ===
                                "queued" ? null : turn.status ===
                                "cancelled" ? (
                                "Stopped. Your message is saved."
                              ) : (
                                turn.error
                              )}
                            </BubbleContent>
                          </Bubble>
                          {turn.answer && (
                            <MessageFooter>
                              <CopyReply text={turn.answer} />
                              {turn.status === "cancelled"
                                ? "Stopped"
                                : turn.status === "failed"
                                  ? "Interrupted"
                                  : ""}
                            </MessageFooter>
                          )}
                          {turn.error && turn.answer && (
                            <Alert>
                              <AlertDescription>{turn.error}</AlertDescription>
                            </Alert>
                          )}
                        </MessageContent>
                      </Message>
                    </MessageScrollerItem>,
                  ])
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
        <div className="composer-area">
          {error && (
            <Alert>
              <AlertDescription className="flex items-center justify-between gap-3">
                {error}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Reconnect"
                  onClick={() => setRefresh((n) => n + 1)}
                >
                  <RefreshCw />
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {state && !state.connected && (
            <Alert>
              <AlertDescription>
                Connect your ChatGPT account using <code>pnpm model:login</code>{" "}
                in the project, then deploy. Your chat is ready; the model is
                not connected yet.
              </AlertDescription>
            </Alert>
          )}
          <Composer
            onSend={send}
            onStop={stop}
            active={!!active}
            pending={sending}
            enabled={!!state?.connected}
            model={state?.model ?? ""}
          />
          <div className="composer-footnote">
            <span>
              {state?.memory.ready
                ? "Memory up to date"
                : "Memory catches up in the background"}
            </span>
            <span>Shift + Enter for a new line</span>
          </div>
        </div>
      </section>
    </main>
  )
}
function Composer({
  onSend,
  onStop,
  active,
  pending,
  enabled,
  model,
}: {
  onSend: (text: string) => Promise<boolean>
  onStop: () => void
  active: boolean
  pending: boolean
  enabled: boolean
  model: string
}) {
  const [draft, setDraft] = useState("")
  async function send() {
    const text = draft.trim()
    if (!text || pending || !enabled) return
    if (await onSend(text))
      setDraft((current) => (current.trim() === text ? "" : current))
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void send()
      }}
    >
      <InputGroup className="chat-composer">
        <InputGroupTextarea
          aria-label="Message Pi"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={30_000}
          placeholder="Message Pi…"
          rows={2}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault()
              void send()
            }
          }}
        />
        <InputGroupAddon align="block-end">
          <InputGroupText>
            <Sparkles />
            {model.replaceAll("-", " ") || "Your personal agent"}
          </InputGroupText>
          <div className="ml-auto flex gap-2">
            {active && (
              <InputGroupButton
                type="button"
                variant="outline"
                size="icon-sm"
                onClick={onStop}
                aria-label="Stop response"
              >
                <Square />
              </InputGroupButton>
            )}
            <InputGroupButton
              type="submit"
              size="icon-sm"
              disabled={!draft.trim() || pending || !enabled}
              aria-label={active ? "Queue message" : "Send message"}
            >
              <ArrowUp />
            </InputGroupButton>
          </div>
        </InputGroupAddon>
      </InputGroup>
    </form>
  )
}
function CopyReply({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={copied ? "Copied" : "Copy response"}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => setCopied(true))
      }
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  )
}
function MemoryPanel({ state }: { state: ChatState | null }) {
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
            <TabsTrigger value="history">Find in history</TabsTrigger>
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
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          img: ({ alt }) => <span>[Image: {alt}]</span>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
