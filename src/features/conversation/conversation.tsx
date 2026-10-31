import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import { Empty, EmptyHeader, EmptyTitle } from "@workspace/ui/components/empty"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { Array as EffectArray, Option, Schema } from "effect"
import { ArrowUp, ChevronDown, Square, RefreshCw, Upload } from "lucide-react"
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react"

import type { AgentProfile } from "@/agents/contracts"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu"
import {
  InputGroup,
  InputGroupTextarea,
  InputGroupAddon,
  InputGroupButton,
} from "@/components/ui/input-group"
import { Message, MessageContent, MessageHeader } from "@/components/ui/message"
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
} from "@/components/ui/message-scroller"
import type { ChatState } from "@/conversations/contracts"
import { ThinkingLevel, type SubmissionMode } from "@/conversations/turns"
import { ApprovalCard, DecisionDock } from "@/features/access"
import { useFamily } from "@/features/family/context"
import {
  type FilesState,
  UploadStatus,
  FileAttachments,
} from "@/features/files"
import { MessageFileControls } from "@/features/files/message-file-controls"
import { markReady } from "@/features/performance"
import { AnswerExplorer } from "@/features/rich-results/explorer"
import type { Profile, JobType } from "@/inference/policy"

import "./conversation.css"

import { ChatHeader } from "./chat-header"
import { useMessageDeliveryDefault } from "./delivery-preference"
import { ModelMenu } from "./model-menu"
import { QueuedTurnAnchor } from "./queued-turn-anchor"
import { RecoveryControls } from "./recovery-controls"
import { TurnDelivery } from "./turn-delivery"
import { TurnReply } from "./turn-reply"
import type { ComposerDraftState } from "./use-composer-draft"
import type { useConversation } from "./use-conversation"
import { useConversationCommands } from "./use-conversation-commands"

export function Conversation({
  composerDraft,
  name,
  userImage,
  agent,
  workbenchAction,
  files,
  conversation,
  sending,
  setSending,
  onSettings,
  onAppPendingChange,
}: {
  composerDraft: ComposerDraftState
  name: string
  userImage?: string | null
  agent: AgentProfile
  workbenchAction?: ReactNode
  files: FilesState
  conversation: ReturnType<typeof useConversation>
  sending: boolean
  setSending: (value: boolean) => void
  onSettings: (
    category:
      | "agent-settings"
      | "general"
      | "models"
      | "access"
      | "connections"
      | "skills"
      | "model-access"
  ) => void
  onAppPendingChange?: (key: string, pending: boolean) => void
}) {
  const archived = agent.status === "archived"
  const { text: draft, profile, job } = composerDraft.value
  const setDraft = (change: string | ((text: string) => string)) =>
    composerDraft.update((current) => ({
      text: typeof change === "function" ? change(current.text) : change,
    }))
  const setProfile = (profile: Profile) => composerDraft.update({ profile })
  const setJob = (job: JobType) => composerDraft.update({ job })
  const composerInput = useRef<HTMLTextAreaElement>(null)
  const answerPrompt = archived
    ? undefined
    : (prompt: string) => {
        void setDraft((current) =>
          current.trim() ? `${current}\n\n${prompt}` : prompt
        )
        requestAnimationFrame(() => composerInput.current?.focus())
      }
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const commands = useConversationCommands(
    agent.id,
    composerDraft,
    files,
    conversation.submit,
    setSending
  )
  const { error, retrying } = commands
  const { state, error: connectionError, reload } = conversation
  const active = state?.turns.find((t) =>
    ["queued", "preparing", "running", "stopping"].includes(t.status)
  )
  // The recent-history window replaces its oldest turn at 100 entries.
  // With an unchanged row count, the scroller treats an unhandled historical
  // anchor as new. Only the latest eligible turn should start a scroll.
  const scrollAnchorId =
    state &&
    EffectArray.findLast(
      state.turns,
      (turn) => turn.status !== "queued" || turn.id === active?.id
    ).pipe(
      Option.map((turn) => turn.id),
      Option.getOrUndefined
    )
  useEffect(() => {
    if (state) markReady("history")
    if (composerInput.current && !composerInput.current.disabled)
      markReady("composer")
  }, [state])
  function send(text: string, mode: SubmissionMode) {
    if (archived || !composerDraft.ready || composerDraft.unreadable)
      return Promise.resolve(false)
    return commands.send({
      text,
      mode,
      files: files.selected.map((file) => file.id),
      profile,
      job,
    })
  }
  function retry(id: string) {
    commands.retry(
      id,
      !archived &&
        !state?.turns.some(
          (turn) =>
            turn.controlUnconfirmed &&
            (turn.id === id ||
              turn.steering?.some((member) => member.id === id))
        )
    )
  }
  function stop() {
    if (active) commands.cancel(active.id)
  }
  return (
    <section
      className="chat-workspace"
      onDragEnter={(event) => {
        if (
          archived ||
          !files.ready ||
          !event.dataTransfer.types.includes("Files")
        )
          return
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
        if (!archived && files.ready && !sending && !files.uploading)
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
      <ChatHeader
        name={name}
        userImage={userImage}
        agent={agent}
        workbenchAction={workbenchAction}
      />
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
                      <EmptyTitle>What would you like to work on?</EmptyTitle>
                    </EmptyHeader>
                  </Empty>
                </MessageScrollerItem>
              ) : (
                state.turns.flatMap((turn) => {
                  const waiting =
                    turn.status === "queued" && turn.id !== active?.id
                  const human = humanMessage(turn)
                  return [
                    <MessageScrollerItem
                      key={`${turn.id}:user`}
                      messageId={`${turn.id}:user`}
                      scrollAnchor={turn.id === scrollAnchorId}
                    >
                      <Message
                        align={human ? "end" : "start"}
                        className={
                          human ? "owner-message" : "background-message"
                        }
                        data-queued={waiting}
                      >
                        <MessageContent>
                          {human && <MessageHeader>{name}</MessageHeader>}
                          <Bubble
                            align={human ? "end" : "start"}
                            variant={human ? "secondary" : "muted"}
                          >
                            <BubbleContent className="message-text">
                              {turn.provenance && (
                                <span className="mb-1 block text-xs text-muted-foreground">
                                  {authorLabels[turn.provenance.author.kind]}
                                </span>
                              )}
                              {messageText(turn)}
                              <FileAttachments
                                files={turn.attachments ?? []}
                                agentId={agent.id}
                              />
                              <TurnDelivery
                                turn={turn}
                                waiting={waiting}
                                onCancel={() => commands.cancel(turn.id)}
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
                          onRetry={
                            turn.controlUnconfirmed
                              ? undefined
                              : (id) => void retry(id)
                          }
                          retrying={retrying}
                          canRetry={!archived && !!state.connected && !retrying}
                        />
                        <RecoveryControls
                          turn={turn}
                          agentId={agent.id}
                          refresh={reload}
                        />
                        {state.access?.approvals
                          .filter(
                            (value) =>
                              value.turnId === turn.id &&
                              value.status !== "pending"
                          )
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
          onModelAccess={() => onSettings("model-access")}
          state={state}
          archived={archived}
          error={error}
          connectionError={connectionError}
          reload={reload}
        />
        <DecisionDock
          agentId={agent.id}
          agentName={agent.name}
          access={state?.access}
          disabled={archived || active?.status === "stopping"}
          onRefresh={reload}
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
            pending={
              !commands.ready ||
              composerUnavailable(sending, files, composerDraft)
            }
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
                  disabled={sending || !!commands.pending}
                  selection={{
                    model: state?.model ?? "",
                    thinking: Schema.is(ThinkingLevel)(state?.thinking)
                      ? state.thinking
                      : "medium",
                    settingsRevision: state?.settingsRevision ?? 0,
                  }}
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
      <InputGroup className="chat-composer" data-working={working}>
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
          rows={1}
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
                      className="composer-delivery-trigger"
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
                className="composer-action"
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
              className="composer-action"
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
    </form>
  )
}

function ConversationConnection({
  onModelAccess,
  state,
  archived,
  error,
  connectionError,
  reload,
}: {
  onModelAccess: () => void
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
                onClick={onModelAccess}
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
    !active.controlUnconfirmed &&
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

const authorLabels = {
  human: "Human message",
  agent: "Agent message",
  service: "Automated message",
}
const humanMessage = (
  turn: Pick<ChatState["turns"][number], "provenance" | "origin">
) =>
  turn.provenance?.author.kind === "human" || (!turn.provenance && !turn.origin)
function messageText(
  turn: Pick<ChatState["turns"][number], "origin" | "text">
) {
  switch (turn.origin?.kind) {
    case "email":
      return `Email · ${turn.text}`
    case "whatsapp":
      return `WhatsApp · ${turn.text}`
    case "communication":
      return "Bot task result"
    case "background":
      return `Background findings · group ${turn.origin.groupId}`
    default:
      return turn.text
  }
}

function composerUnavailable(
  sending: boolean,
  files: FilesState,
  draft: ComposerDraftState
) {
  return sending || files.uploading || !draft.ready || draft.unreadable
}
