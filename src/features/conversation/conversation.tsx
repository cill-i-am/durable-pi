import { useCallback, useMemo, useRef, useState } from "react"
import { ArrowUp, Square, Sparkles, RefreshCw } from "lucide-react"
import { useConversation } from "./use-conversation"
import { TurnReply } from "./turn-reply"
import { ModelMenu } from "./model-menu"
import { submissionAttempt } from "./commands"
import {
  ThinkingLevel,
  type Submission,
  type SubmissionMode,
} from "@/conversations/turns"
import { Schema } from "effect"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { AgentProfile } from "@/agents/contracts"
import { agentApi } from "@/http/client"
import { MemoryPanel } from "@/features/memory"
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
} from "@/components/ui/input-group"
import { Message, MessageContent, MessageFooter } from "@/components/ui/message"
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
  const [error, setError] = useState("")
  const [sending, setSending] = useState(false)
  const [retrying, setRetrying] = useState<string | null>(null)
  const retryKeys = useRef(new Map<string, string>())
  const pending = useRef<Submission | null>(null)
  const [refresh, setRefresh] = useState(0)
  const reload = useCallback(() => setRefresh((n) => n + 1), [])
  const { state, error: connectionError } = useConversation(agent.id, refresh)
  const active = state?.turns.find((t) =>
    ["queued", "preparing", "running", "stopping"].includes(t.status)
  )
  async function send(text: string, mode: SubmissionMode) {
    setSending(true)
    setError("")
    pending.current = submissionAttempt(pending.current, text, mode)
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
  async function retry(id: string) {
    if (retrying) return
    setRetrying(id)
    setError("")
    const operationId = retryKeys.current.get(id) ?? crypto.randomUUID()
    retryKeys.current.set(id, operationId)
    try {
      await api("retry", { turnId: id, operationId })
      retryKeys.current.delete(id)
      reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not retry.")
    } finally {
      setRetrying(null)
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
          <Badge variant="secondary">
            {active?.status === "stopping"
              ? "Stopping"
              : active
                ? "Working"
                : "Ready"}
          </Badge>
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
                    <TurnReply
                      turn={turn}
                      agentName={agent.name}
                      onRetry={(id) => void retry(id)}
                      retrying={retrying}
                      canRetry={!!state.connected && !retrying}
                    />
                  </MessageScrollerItem>,
                ])
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
      <div className="composer-area">
        {(error || connectionError) && (
          <Alert>
            <AlertDescription className="flex items-center justify-between gap-3">
              {error || connectionError}
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
          stopping={active?.status === "stopping"}
          pending={sending}
          enabled={!!state?.connected}
          modelControl={
            <ModelMenu
              agentId={agent.id}
              selection={{
                model: state?.model ?? "",
                thinking: Schema.is(ThinkingLevel)(state?.thinking)
                  ? state.thinking
                  : "medium",
                settingsRevision: state?.settingsRevision ?? 0,
              }}
              onSaved={reload}
              onError={setError}
            />
          }
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
  stopping,
  pending,
  enabled,
  modelControl,
}: {
  name: string
  onSend: (text: string, mode: SubmissionMode) => Promise<boolean>
  onStop: () => void
  active: boolean
  stopping: boolean
  pending: boolean
  enabled: boolean
  modelControl: React.ReactNode
}) {
  const [draft, setDraft] = useState("")
  const [mode, setMode] = useState<SubmissionMode>("steer")
  const delivery = active && !stopping ? mode : "followUp"
  async function send() {
    const text = draft.trim()
    if (!text || pending || !enabled) return
    if (await onSend(text, delivery))
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
        <InputGroupAddon align="block-end" className="flex-wrap">
          <div className="max-w-full min-w-0">{modelControl}</div>
          <div className="ml-auto flex gap-2">
            {active && (
              <InputGroupButton
                type="button"
                variant="outline"
                size="icon-sm"
                onClick={onStop}
                disabled={stopping}
                aria-label="Stop response"
              >
                <Square />
              </InputGroupButton>
            )}
            <InputGroupButton
              type="submit"
              size="icon-sm"
              disabled={!draft.trim() || pending || !enabled}
              aria-label={
                active
                  ? delivery === "steer"
                    ? "Steer response"
                    : "Queue message"
                  : "Send message"
              }
            >
              <ArrowUp />
            </InputGroupButton>
          </div>
        </InputGroupAddon>
      </InputGroup>
      {active && (
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <ToggleGroup
            size="sm"
            variant="outline"
            value={[delivery]}
            disabled={stopping || pending}
            onValueChange={(values) => {
              const value = values[0]
              if (value === "steer" || value === "followUp") setMode(value)
            }}
            aria-label="Message delivery"
          >
            <ToggleGroupItem value="steer">Steer</ToggleGroupItem>
            <ToggleGroupItem value="followUp">Queue</ToggleGroupItem>
          </ToggleGroup>
          <span className="text-xs text-muted-foreground">
            {stopping
              ? "Stopping. New messages will wait."
              : delivery === "steer"
                ? "Joins this reply at the next tool boundary."
                : "Starts a new reply after this one finishes."}
          </span>
        </div>
      )}
    </form>
  )
}
