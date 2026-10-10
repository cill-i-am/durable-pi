import { useEffect, useMemo, useRef, useState } from "react"
import { ArrowUp, Check, Square, Sparkles, Copy, RefreshCw } from "lucide-react"
import type { ChatState } from "@/shared/contracts"
import type { AgentProfile } from "@/agents/contracts"
import { agentApi } from "@/http/client"
import { MemoryPanel } from "@/features/memory"
import { Markdown } from "@/components/markdown"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Button } from "@/components/ui/button"
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

export function Conversation({
  name,
  agent,
}: {
  name: string
  agent: AgentProfile
}) {
  const api = useMemo(() => agentApi(agent.id), [agent.id])
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
  }, [refresh, api])
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
    <section className="chat-workspace">
      <header className="chat-header">
        <div className="flex min-w-0 items-center gap-3">
          <SidebarTrigger />
          <span className="bot-avatar" aria-hidden="true">
            {agent.name.slice(0, 1)}
          </span>
          <h1 className="truncate text-sm font-semibold">{agent.name}</h1>
          <Badge variant="secondary">{active ? "Working" : "Ready"}</Badge>
        </div>
        <MemoryPanel state={state} agentId={agent.id} />
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
                      This bot has its own conversation and memory.
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
                            : new Date(turn.created_at).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
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
                          <span className="assistant-label">{agent.name}</span>
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
                              "queued" ? null : turn.status === "cancelled" ? (
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
              Your model connection is unavailable. Reconnect it before sending
              a message.
            </AlertDescription>
          </Alert>
        )}
        <Composer
          name={agent.name}
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
  )
}
function Composer({
  name,
  onSend,
  onStop,
  active,
  pending,
  enabled,
  model,
}: {
  name: string
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
          aria-label={`Message ${name}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={30_000}
          placeholder={`Message ${name}…`}
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
