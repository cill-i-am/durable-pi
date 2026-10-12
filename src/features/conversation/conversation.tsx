import { AgentMark, agentTone } from "@/components/agent-mark"
import type { Profile, JobType } from "@/inference/policy"
import {
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react"
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
import type { useConversation } from "./use-conversation"
import { TurnReply } from "./turn-reply"
import { QueuedTurnAnchor } from "./queued-turn-anchor"
import { ModelMenu } from "./model-menu"
import { submissionAttempt, rejectedModelAttempt } from "./commands"
import {
  ThinkingLevel,
  type Submission,
  type SubmissionMode,
} from "@/conversations/turns"
import { Schema } from "effect"
import type { AgentProfile } from "@/agents/contracts"
import { agentApi } from "@/http/client"
import {
  type FilesState,
  FilePicker,
  UploadStatus,
  FileAttachments,
} from "@/features/files"
import { ApprovalCard } from "@/features/access"
import { SidebarTrigger } from "@/components/ui/sidebar"
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
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
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
  workbenchAction,
  files,
  conversation,
  sending,
  setSending,
  onOpenWorkbench,
  onSettings,
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
}) {
  const api = useMemo(() => agentApi(agent.id), [agent.id])
  const [draft, setDraft] = useState("")
  const composerInput = useRef<HTMLTextAreaElement>(null)
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
  async function send(text: string, mode: SubmissionMode) {
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
      reload()
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
      reload()
    } catch {
      setError("Could not stop the turn. Try again.")
    }
  }
  return (
    <section
      className="chat-workspace"
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return
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
        if (!sending && !files.uploading)
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
              <Badge variant="secondary">
                {active?.status === "stopping"
                  ? "Stopping"
                  : state?.access?.approvals.some(
                        (value) => value.status === "pending"
                      )
                    ? "Needs approval"
                    : active
                      ? "Working"
                      : "Ready"}
              </Badge>
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
                        A little space to think.
                        <br />
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
                          disabled={sending || !!draft}
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
                state.turns.flatMap((turn) => [
                  <MessageScrollerItem
                    key={`${turn.id}:user`}
                    messageId={`${turn.id}:user`}
                    scrollAnchor={turn.status !== "queued"}
                  >
                    <Message
                      align={turn.origin ? "start" : "end"}
                      className={
                        turn.origin ? "background-message" : "owner-message"
                      }
                      data-queued={turn.status === "queued"}
                    >
                      <MessageContent>
                        <Bubble
                          align={turn.origin ? "start" : "end"}
                          variant={turn.origin ? "muted" : "secondary"}
                        >
                          <BubbleContent className="message-text">
                            {turn.origin
                              ? turn.origin.kind === "communication"
                                ? "Bot task result"
                                : `Background findings · group ${turn.origin.groupId}`
                              : turn.text}
                            <FileAttachments
                              files={turn.attachments ?? []}
                              agentId={agent.id}
                            />
                            <MessageFooter
                              className={
                                turn.status === "queued"
                                  ? undefined
                                  : "message-timestamp"
                              }
                            >
                              {turn.status === "queued"
                                ? "Queued"
                                : new Date(turn.created_at).toLocaleTimeString(
                                    [],
                                    {
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    }
                                  )}
                              {turn.status === "queued" && (
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  onClick={() =>
                                    void api("cancel", { operationId: turn.id })
                                      .then(() => reload())
                                      .catch(() =>
                                        setError("Could not cancel.")
                                      )
                                  }
                                >
                                  Cancel
                                </Button>
                              )}
                            </MessageFooter>
                          </BubbleContent>
                        </Bubble>
                      </MessageContent>
                    </Message>
                  </MessageScrollerItem>,
                  turn.status === "queued" ? null : (
                    <MessageScrollerItem
                      key={`${turn.id}:assistant`}
                      messageId={`${turn.id}:assistant`}
                    >
                      <TurnReply
                        turn={turn}
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
                        canRetry={!!state.connected && !retrying}
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
                            onDecided={reload}
                            disabled={
                              turn.status === "stopping" ||
                              !["queued", "preparing", "running"].includes(
                                turn.status
                              )
                            }
                          />
                        ))}
                    </MessageScrollerItem>
                  ),
                ])
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
        {state && <QueuedTurnAnchor turns={state.turns} />}
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
                onClick={() => reload()}
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
          draft={draft}
          setDraft={setDraft}
          inputRef={composerInput}
          name={agent.name}
          onSend={send}
          onStop={stop}
          active={!!active}
          stopping={active?.status === "stopping"}
          pending={sending || files.uploading}
          hasAttachments={files.selected.length > 0}
          attachments={
            <>
              <FileAttachments
                files={files.selected}
                agentId={agent.id}
                onRemove={sending ? undefined : files.remove}
              />
              <UploadStatus state={files} />
              {files.error && (
                <p role="alert" className="py-2 text-sm text-destructive">
                  {files.error}
                </p>
              )}
            </>
          }
          attachmentControl={
            <FilePicker
              state={files}
              disabled={sending || files.selected.length >= 4}
            />
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
  draft,
  setDraft,
  inputRef,
  name,
  onSend,
  onStop,
  active,
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
  stopping: boolean
  pending: boolean
  enabled: boolean
  modelControl: (delivery: SubmissionMode) => React.ReactNode
  attachments: React.ReactNode
  attachmentControl: React.ReactNode
  hasAttachments: boolean
}) {
  const [mode, setMode] = useState<SubmissionMode>("steer")
  const delivery = active && !stopping ? mode : "followUp"
  async function send() {
    const text = draft.trim()
    if ((!text && !hasAttachments) || pending || !enabled) return
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
      {attachments}
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
                    <DropdownMenuLabel>While this reply runs</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={delivery}
                      onValueChange={(value) => {
                        if (value === "steer" || value === "followUp")
                          setMode(value)
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
                (!draft.trim() && !hasAttachments) || pending || !enabled
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
      {active && (
        <div className="composer-delivery">
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
