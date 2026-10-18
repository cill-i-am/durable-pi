import { Schema } from "effect"
import {
  ArrowUp,
  ChevronDown,
  Square,
  RefreshCw,
  ListTodo,
  Compass,
  Image,
  ArrowRight,
  Upload,
  Files,
  BookOpen,
  Ellipsis,
  ShieldCheck,
  Plug,
} from "lucide-react"
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react"

import type { AgentProfile } from "@/agents/contracts"
import { ActivityBorder } from "@/components/activity-visuals"
import { AgentMark, agentTone } from "@/components/agent-mark"
import { AgentStatus } from "@/components/agent-status"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@/components/ui/empty"
import {
  InputGroup,
  InputGroupTextarea,
  InputGroupAddon,
  InputGroupButton,
} from "@/components/ui/input-group"
import { Message, MessageContent } from "@/components/ui/message"
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
} from "@/components/ui/message-scroller"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import {
  ThinkingLevel,
  type Submission,
  type SubmissionMode,
} from "@/conversations/turns"
import { ApprovalCard } from "@/features/access"
import { useFamily } from "@/features/family/context"
import {
  type FilesState,
  UploadStatus,
  FileAttachments,
} from "@/features/files"
import { MessageFileControls } from "@/features/files/message-file-controls"
import { markReady } from "@/features/performance"
import { AnswerExplorer } from "@/features/rich-results/explorer"
import { agentApi } from "@/http/client"
import type { Profile, JobType } from "@/inference/policy"

import { submissionAttempt, rejectedModelAttempt } from "./commands"
import { useMessageDeliveryDefault } from "./delivery-preference"
import { ModelMenu } from "./model-menu"
import { QueuedTurnAnchor } from "./queued-turn-anchor"
import { TurnDelivery } from "./turn-delivery"
import { TurnReply } from "./turn-reply"
import type { useConversation } from "./use-conversation"

export function Conversation({
  name,
  agent,
  workbenchAction,
  files,
  conversation,
  sending,
  setSending,
  onOpenWorkbench,
  onSettings,
  onAppPendingChange,
}: {
  name: string
  agent: AgentProfile
  workbenchAction?: ReactNode
  files: FilesState
  conversation: ReturnType<typeof useConversation>
  sending: boolean
  setSending: (value: boolean) => void
  onSettings: (category: "models" | "access" | "connections" | "skills") => void
  onOpenWorkbench: (value: "files" | "memory") => void
  onAppPendingChange?: (key: string, pending: boolean) => void
}) {
  const archived = agent.status === "archived"
  const api = useMemo(() => agentApi(agent.id), [agent.id])
  const [draft, setDraft] = useState("")
  const composerInput = useRef<HTMLTextAreaElement>(null)
  const answerPrompt = archived
    ? undefined
    : (prompt: string) => {
        setDraft((current) =>
          current.trim() ? `${current}\n\n${prompt}` : prompt
        )
        requestAnimationFrame(() => composerInput.current?.focus())
      }
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const [profile, setProfile] = useState<Profile>("auto")
  const [job, setJob] = useState<JobType>("conversation")
  const [error, setError] = useState("")
  const [retrying, setRetrying] = useState<string | null>(null)
  const retryKeys = useRef(new Map<string, string>())
  const pending = useRef<Submission | null>(null)
  const { state, error: connectionError, reload } = conversation
  const active = state?.turns.find((t) =>
    ["queued", "preparing", "running", "stopping"].includes(t.status)
  )
  useEffect(() => {
    if (state) markReady("history")
    if (composerInput.current && !composerInput.current.disabled)
      markReady("composer")
  }, [state])
  async function send(text: string, mode: SubmissionMode) {
    if (archived) return false
    setSending(true)
    setError("")
    pending.current = submissionAttempt(
      pending.current,
      text,
      mode,
      files.selected.map((file) => file.id),
      profile,
      job
    )
    try {
      const submittedFiles = pending.current.files ?? []
      await conversation.submit(pending.current)
      files.clear(submittedFiles)
      pending.current = null
      setProfile("auto")
      setJob("conversation")
      return true
    } catch (e) {
      if (rejectedModelAttempt(e)) pending.current = null
      setError(e instanceof Error ? e.message : "Could not send")
      return false
    } finally {
      setSending(false)
    }
  }
  async function retry(id: string) {
    if (archived || retrying) return
    setRetrying(id)
    setError("")
    const operationId = retryKeys.current.get(id) ?? crypto.randomUUID()
    retryKeys.current.set(id, operationId)
    try {
      await api("retry", { turnId: id, operationId })
      retryKeys.current.delete(id)
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
    } catch {
      setError("Could not stop the turn. Try again.")
    }
  }
  return (
    <section
      className="chat-workspace"
      onDragEnter={(event) => {
        if (archived || !event.dataTransfer.types.includes("Files")) return
        event.preventDefault()
        dragDepth.current++
        setDragging(true)
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault()
      }}
      onDragLeave={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (!dragDepth.current) setDragging(false)
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return
        event.preventDefault()
        dragDepth.current = 0
        setDragging(false)
        if (!archived && !sending && !files.uploading)
          void files.upload(Array.from(event.dataTransfer.files), true)
      }}
    >
      {dragging && (
        <div className="conversation-drop" role="status">
          <Upload />
          <strong>
            {sending || files.uploading
              ? "Finish the current upload first"
              : "Drop files into the conversation"}
          </strong>
          <span>Images, videos and documents · up to 8 MB each</span>
        </div>
      )}
      <header className="chat-header">
        <div className="chat-identity">
          <SidebarTrigger />
          <AgentMark tone={agentTone(agent.id)} />
          <div className="chat-identity-copy">
            <div className="chat-identity-title">
              <h1>{agent.name}</h1>
              <AgentStatus
                status={
                  archived
                    ? "archived"
                    : connectionError
                      ? "unavailable"
                      : state?.runtime?.state
                }
              />
            </div>
            <p>
              {agent.instructions.split("\n")[0] ||
                "Your personal thinking partner"}
            </p>
          </div>
        </div>
        <div className="chat-header-actions">
          {workbenchAction}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Agent settings and tools"
                />
              }
            >
              <Ellipsis />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel>{agent.name}</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => onSettings("access")}>
                  <ShieldCheck /> Tool access
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onSettings("connections")}>
                  <Plug /> Connections
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onSettings("skills")}>
                  <BookOpen /> Skills
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={() => onOpenWorkbench("files")}>
                  <Files /> Files
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onOpenWorkbench("memory")}>
                  <BookOpen /> Memory
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
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
                      <AgentMark tone={agentTone(agent.id)} />
                      <EmptyTitle>Hello, {name.split(" ")[0]}.</EmptyTitle>
                      <EmptyDescription>
                        What would you like to work on?
                      </EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent className="conversation-starters">
                      {[
                        {
                          icon: ListTodo,
                          label: "Turn a project into a checklist",
                          text: "Help me plan a project and create a checklist. ",
                        },
                        {
                          icon: Compass,
                          label: "Plan a slower weekend away",
                          text: "Help me plan a slower weekend away. ",
                        },
                        {
                          icon: Image,
                          label: "Make something from a reference",
                          text: "Help me make something from a reference. ",
                        },
                      ].map((suggestion) => (
                        <Button
                          key={suggestion.label}
                          variant="ghost"
                          disabled={archived || sending || !!draft}
                          onClick={() => {
                            setDraft(suggestion.text)
                            composerInput.current?.focus()
                          }}
                        >
                          <suggestion.icon data-icon="inline-start" />
                          <span>{suggestion.label}</span>
                          <ArrowRight data-icon="inline-end" />
                        </Button>
                      ))}
                    </EmptyContent>
                  </Empty>
                </MessageScrollerItem>
              ) : (
                state.turns.flatMap((turn) => {
                  const waiting =
                    turn.status === "queued" && turn.id !== active?.id
                  return [
                    <MessageScrollerItem
                      key={`${turn.id}:user`}
                      messageId={`${turn.id}:user`}
                      scrollAnchor={!waiting}
                    >
                      <Message
                        align={turn.origin ? "start" : "end"}
                        className={
                          turn.origin ? "background-message" : "owner-message"
                        }
                        data-queued={waiting}
                      >
                        <MessageContent>
                          <Bubble
                            align={turn.origin ? "start" : "end"}
                            variant={turn.origin ? "muted" : "secondary"}
                          >
                            <BubbleContent className="message-text">
                              {turn.origin
                                ? turn.origin.kind === "email"
                                  ? `Email · ${turn.text}`
                                  : turn.origin.kind === "whatsapp"
                                    ? `WhatsApp · ${turn.text}`
                                    : turn.origin.kind === "communication"
                                      ? "Bot task result"
                                      : `Background findings · group ${turn.origin.groupId}`
                                : turn.text}
                              <FileAttachments
                                files={turn.attachments ?? []}
                                agentId={agent.id}
                              />
                              <TurnDelivery
                                turn={turn}
                                waiting={waiting}
                                onCancel={() =>
                                  void api("cancel", {
                                    operationId: turn.id,
                                  }).catch(() => setError("Could not cancel."))
                                }
                              />
                            </BubbleContent>
                          </Bubble>
                        </MessageContent>
                      </Message>
                    </MessageScrollerItem>,
                    waiting ? null : (
                      <MessageScrollerItem
                        key={`${turn.id}:assistant`}
                        messageId={`${turn.id}:assistant`}
                      >
                        <TurnReply
                          onAnswerPrompt={answerPrompt}
                          onAppPendingChange={onAppPendingChange}
                          turn={turn}
                          waitingForApproval={state.access?.approvals.some(
                            (approval) =>
                              approval.turnId === turn.id &&
                              approval.status === "pending"
                          )}
                          toolTitles={Object.fromEntries(
                            (state.access?.tools ?? []).map((tool) => [
                              tool.name,
                              tool.title ?? tool.name,
                            ])
                          )}
                          agentName={agent.name}
                          agentId={agent.id}
                          onRetry={(id) => void retry(id)}
                          retrying={retrying}
                          canRetry={!archived && !!state.connected && !retrying}
                        />
                        {state.access?.approvals
                          .filter((value) => value.turnId === turn.id)
                          .map((approval) => (
                            <ApprovalCard
                              key={approval.id}
                              approval={approval}
                              agentName={agent.name}
                              toolPolicy={state.access?.tools.find(
                                (tool) => tool.name === approval.tool
                              )}
                              toolLabel={
                                state.access?.tools.find(
                                  (tool) => tool.name === approval.tool
                                )?.title
                              }
                              agentId={agent.id}
                              disabled={
                                archived ||
                                turn.status === "stopping" ||
                                !["queued", "preparing", "running"].includes(
                                  turn.status
                                )
                              }
                            />
                          ))}
                      </MessageScrollerItem>
                    ),
                  ]
                })
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
        {state && <QueuedTurnAnchor turns={state.turns} />}
      </MessageScrollerProvider>
      <div className="composer-area">
        <ConversationConnection
          state={state}
          archived={archived}
          error={error}
          connectionError={connectionError}
          reload={reload}
        />
        {archived ? (
          <p className="py-3 text-sm text-muted-foreground">
            Archived agent. Restore it from the agent menu to continue.
          </p>
        ) : (
          <Composer
            draft={draft}
            setDraft={setDraft}
            inputRef={composerInput}
            name={agent.name}
            onSend={send}
            onStop={stop}
            active={!!active}
            working={conversationWorking(active, state)}
            stopping={active?.status === "stopping"}
            pending={sending || files.uploading}
            hasAttachments={files.selected.length > 0}
            attachments={
              <ComposerAttachments
                files={files}
                agentId={agent.id}
                sending={sending}
              />
            }
            attachmentControl={
              <MessageFileControls files={files} sending={sending} />
            }
            enabled={!!state?.connected && files.attachmentsReady}
            modelControl={(delivery) =>
              delivery === "steer" ? (
                <span
                  className="block truncate text-xs text-muted-foreground"
                  title={`${active?.routing?.model ?? "Active model"} · ${active?.routing?.thinking ?? "pinned effort"}`}
                >
                  Active model
                </span>
              ) : (
                <ModelMenu
                  onOpenSettings={() => onSettings("models")}
                  agentId={agent.id}
                  profile={profile}
                  onProfile={setProfile}
                  job={job}
                  onJob={setJob}
                  disabled={sending || !!pending.current}
                  selection={{
                    model: state?.model ?? "",
                    thinking: Schema.is(ThinkingLevel)(state?.thinking)
                      ? state.thinking
                      : "medium",
                    settingsRevision: state?.settingsRevision ?? 0,
                  }}
                  onError={setError}
                />
              )
            }
          />
        )}
      </div>
    </section>
  )
}
function Composer({
  draft,
  setDraft,
  inputRef,
  name,
  onSend,
  onStop,
  active,
  working,
  stopping,
  pending,
  enabled,
  modelControl,
  attachments,
  attachmentControl,
  hasAttachments,
}: {
  draft: string
  setDraft: React.Dispatch<React.SetStateAction<string>>
  inputRef: RefObject<HTMLTextAreaElement | null>
  name: string
  onSend: (text: string, mode: SubmissionMode) => Promise<boolean>
  onStop: () => void
  active: boolean
  working: boolean
  stopping: boolean
  pending: boolean
  enabled: boolean
  modelControl: (delivery: SubmissionMode) => React.ReactNode
  attachments: React.ReactNode
  attachmentControl: React.ReactNode
  hasAttachments: boolean
}) {
  const defaultMode = useMessageDeliveryDefault()
  const [override, setOverride] = useState<SubmissionMode | null>(null)
  const mode = override ?? defaultMode
  const delivery = active ? mode : "followUp"
  const waitingForStop = stopping && mode === "steer"
  useEffect(() => {
    setOverride(null)
  }, [active, defaultMode])
  async function send() {
    const text = draft.trim()
    if ((!text && !hasAttachments) || pending || !enabled || waitingForStop)
      return
    if (await onSend(text, delivery)) {
      setDraft((current) => (current.trim() === text ? "" : current))
      setOverride(null)
    }
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void send()
      }}
    >
      {attachments}
      <div className="flex justify-start py-1">
        <AnswerExplorer
          disabled={pending}
          onPrompt={(prompt) => {
            setDraft((current) =>
              current.trim() ? `${current}\n\n${prompt}` : prompt
            )
            requestAnimationFrame(() => inputRef.current?.focus())
          }}
        />
      </div>
      <ActivityBorder active={working}>
        <InputGroup className="chat-composer">
          <InputGroupTextarea
            ref={inputRef}
            aria-label={`Message ${name}`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={30_000}
            placeholder={
              active && !stopping
                ? "Add a thought while I work…"
                : `Message ${name}…`
            }
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
          <InputGroupAddon align="block-end" className="composer-controls">
            {attachmentControl}
            <div className="composer-model">{modelControl(delivery)}</div>
            <div
              className="composer-actions"
              role="group"
              aria-label="Send message and delivery"
            >
              {active && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <InputGroupButton
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="composer-delivery-trigger rounded-full"
                        disabled={stopping || pending}
                      />
                    }
                    aria-label={`Message delivery: ${delivery === "steer" ? "steer this reply" : "queue next reply"}`}
                  >
                    {delivery === "steer" ? "Steer" : "Queue"}
                    <ChevronDown data-icon="inline-end" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    side="top"
                    align="end"
                    className="min-w-52"
                  >
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>For this message</DropdownMenuLabel>
                      <DropdownMenuRadioGroup
                        value={delivery}
                        onValueChange={(value: unknown) => {
                          if (value === "steer" || value === "followUp")
                            setOverride(value)
                        }}
                      >
                        <DropdownMenuRadioItem value="steer">
                          Steer this reply
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="followUp">
                          Queue next reply
                        </DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              {active && (
                <InputGroupButton
                  type="button"
                  variant="secondary"
                  size="icon-sm"
                  className="composer-action rounded-full"
                  onClick={onStop}
                  disabled={stopping}
                  aria-label="Stop response"
                  title="Stop response"
                >
                  <Square />
                </InputGroupButton>
              )}
              <InputGroupButton
                type="submit"
                variant="default"
                size="icon-sm"
                className="composer-action rounded-full"
                disabled={
                  (!draft.trim() && !hasAttachments) ||
                  pending ||
                  !enabled ||
                  waitingForStop
                }
                aria-label={
                  active
                    ? delivery === "steer"
                      ? "Steer response"
                      : "Queue message"
                    : "Send message"
                }
                title={
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
      </ActivityBorder>
    </form>
  )
}

function ConversationConnection({
  state,
  archived,
  error,
  connectionError,
  reload,
}: {
  state: ReturnType<typeof useConversation>["state"]
  archived: boolean
  error: string
  connectionError: ReturnType<typeof useConversation>["error"]
  reload: () => void
}) {
  const { family } = useFamily()
  return (
    <>
      {(error || connectionError) && (
        <Alert>
          <AlertDescription className="flex items-center justify-between gap-3">
            {error || connectionError}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Reconnect"
              onClick={() => reload()}
            >
              <RefreshCw />
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {state && !state.connected && !archived && (
        <Alert>
          <AlertDescription>
            {family.role === "owner"
              ? "Reconnect ChatGPT to restore model access for the family. Your draft stays here."
              : `${family.ownerName} needs to reconnect ChatGPT. You can keep writing; your draft stays here.`}
            {family.role === "owner" && (
              <Button
                variant="outline"
                className="mt-3"
                render={
                  <a
                    href="/agents/home/settings/model-access"
                    aria-label="Reconnect ChatGPT"
                  />
                }
              >
                Reconnect ChatGPT
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
    </>
  )
}

function conversationWorking(
  active:
    | NonNullable<ReturnType<typeof useConversation>["state"]>["turns"][number]
    | undefined,
  state: ReturnType<typeof useConversation>["state"]
) {
  return (
    !!active &&
    ["queued", "preparing", "running"].includes(active.status) &&
    !state?.access?.approvals.some((approval) => approval.status === "pending")
  )
}

function ComposerAttachments({
  files,
  agentId,
  sending,
}: {
  files: FilesState
  agentId: string
  sending: boolean
}) {
  return (
    <>
      <FileAttachments
        files={files.selected}
        agentId={agentId}
        onRemove={sending ? undefined : files.remove}
      />
      <UploadStatus state={files} />
      {files.error && (
        <p role="alert" className="py-2 text-sm text-destructive">
          {files.error}
        </p>
      )}
    </>
  )
}
