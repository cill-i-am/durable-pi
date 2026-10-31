import { Link } from "@tanstack/react-router"
import { AgentAvatar } from "@workspace/ui/components/agent-avatar"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { Card, CardFrame, CardFrameFooter } from "@workspace/ui/components/card"
import { DataLoading } from "@workspace/ui/components/data-loading"
import { Switch } from "@workspace/ui/components/switch"
import { Schema } from "effect"
import {
  ArrowLeft,
  BookOpen,
  ChevronRight,
  Globe,
  Plug,
  Play,
  Settings2,
  ShieldCheck,
  X,
  Users,
  User,
  MessageCircle,
} from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

import type { AgentProfile } from "@/agents/contracts"
import { authClient } from "@/auth/client"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { useOverlayMobile } from "@/components/ui/responsive-overlay"
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar"
import { UserAvatar } from "@/components/user-avatar"
import { AccessPanel } from "@/features/access"
import { AppearanceSettings } from "@/features/appearance/appearance-settings"
import { AccountSecurity } from "@/features/auth/account-security"
import { ProfilePhoto } from "@/features/auth/profile-photo"
import { ConnectionsPanel } from "@/features/connections"
import type { useConversation } from "@/features/conversation"
import { MessageDeliverySettings } from "@/features/conversation"
import { ModelDefaults } from "@/features/conversation/model-defaults"
import { EmailSettings } from "@/features/email"
import { useFamily } from "@/features/family/context"
import { FamilySettings } from "@/features/family/family-settings"
import { ModelAccess } from "@/features/family/model-access"
import { SkillsPanel } from "@/features/skills"
import { ChannelSettings } from "@/features/whatsapp/channel-settings"
import { useInteractionSoundPreference } from "@/hooks/interaction-sound-preference"
import { useInteractionSound } from "@/hooks/use-interaction-sound"
import { ThinkingLevel } from "@/inference/selection"
import type { SettingsFrame } from "@/navigation/settings-stack"
import { isGlobalSettingsSection } from "@/navigation/workspace"
import type { SettingsCategory } from "@/navigation/workspace"

import "./workspace-settings.css"

import { useSettingsDrawers } from "./use-settings-drawers"
import { useWorkspaceLocation } from "./use-workspace-location"
import type { Workbench } from "./workspace-navigation"

const personalSections = [
  { id: "account", title: "Account", icon: User },
  { id: "preferences", title: "Preferences", icon: Settings2 },
  { id: "security", title: "Account security", icon: ShieldCheck },
  { id: "connection-library", title: "Connections", icon: Plug },
  { id: "skill-library", title: "Skills", icon: BookOpen },
  { id: "channels", title: "Channels", icon: MessageCircle },
  { id: "family", title: "Family", icon: Users },
  { id: "model-access", title: "Model access", icon: Plug },
] as const
const agentSections = [
  { id: "general", title: "General", icon: Settings2 },
  { id: "models", title: "Models", icon: Plug },
  { id: "connections", title: "Connections", icon: Plug },
  { id: "access", title: "Tool access", icon: ShieldCheck },
  { id: "skills", title: "Skills", icon: BookOpen },
] as const
export type { SettingsCategory } from "@/navigation/workspace"

type SettingsProps = {
  category: SettingsCategory | null
  onCategoryChange: (category: SettingsCategory | null) => void
  agent?: AgentProfile
  agents: readonly AgentProfile[]
  conversation: ReturnType<typeof useConversation>
  onPendingChange: (pending: boolean) => void
  onShownChange?: (shown: boolean) => void
  onWorkbench: (workbench: Workbench) => void
}
type Location = ReturnType<typeof useWorkspaceLocation>
type StackContext = {
  props: SettingsProps
  location: Location
  locked: boolean
  pending: (id: string, value: boolean) => void
  exit: (action?: () => void) => void
}
function frameTitle(frame: SettingsFrame) {
  if (frame.category === "settings") return "Settings"
  if (frame.category === "agent-settings") return "Assistant settings"
  return (
    [...personalSections, ...agentSections].find(
      (item) => item.id === frame.category
    )?.title ?? "Settings"
  )
}

export function WorkspaceSettings(props: SettingsProps) {
  const { onPendingChange, onShownChange } = props
  const location = useWorkspaceLocation(
    props.agent ? [props.agent] : [],
    props.agent
  )
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const locked = Object.values(pending).some(Boolean)
  const drawers = useSettingsDrawers(
    !props.category ? [] : location.settingsFrames,
    { href: location.href, locked }
  )
  const reportPending = useCallback((id: string, value: boolean) => {
    setPending((current) =>
      current[id] === value ? current : { ...current, [id]: value }
    )
  }, [])
  const shown = drawers.frames.length > 0
  useEffect(() => {
    onShownChange?.(shown)
    return () => onShownChange?.(false)
  }, [shown, onShownChange])
  useEffect(() => {
    onPendingChange(locked)
    return () => onPendingChange(false)
  }, [locked, onPendingChange])
  const exit = (action?: () => void) =>
    drawers.exit(action ?? location.closeSettings)
  const root = drawers.frames[0]
  if (!root) return null
  const context = { props, location, locked, pending: reportPending, exit }
  return (
    <SettingsRoot
      key={root.id}
      root={root}
      frames={drawers.frames}
      depth={drawers.depth}
      context={context}
      onClosed={drawers.closed}
      onLayerClosed={drawers.closed}
    />
  )
}

function SettingsRoot({
  root,
  frames,
  depth,
  context,
  onClosed,
  onLayerClosed,
}: {
  root: SettingsFrame
  frames: readonly SettingsFrame[]
  depth: number
  context: StackContext
  onClosed: (id: string) => void
  onLayerClosed: (id: string) => void
}) {
  const [entered, setEntered] = useState(false)
  useEffect(() => setEntered(true), [])
  const open = entered && depth > 0
  return (
    <Dialog
      desktop="page"
      modal={depth === 1}
      open={open}
      dismissible={!context.locked}
      onOpenChange={(next) => {
        if (!next) context.exit()
      }}
      onOpenChangeComplete={(next) => {
        if (!next && entered) onClosed(root.id)
      }}
    >
      <SettingsPresentation
        root={root}
        frames={frames}
        depth={depth}
        context={context}
        onLayerClosed={onLayerClosed}
      />
    </Dialog>
  )
}

function SettingsPresentation({
  root,
  frames,
  depth,
  context,
  onLayerClosed,
}: {
  root: SettingsFrame
  frames: readonly SettingsFrame[]
  depth: number
  context: StackContext
  onLayerClosed: (id: string) => void
}) {
  const { state: sidebarState } = useSidebar()
  const mobile = useOverlayMobile()
  const active = frames[Math.max(0, depth - 1)] ?? root
  const global = isGlobalSettingsSection(root.category)
  const rows = useRef(new Map<string, HTMLElement>())
  return (
    <DialogContent
      showCloseButton={false}
      container={document.getElementById("settings-page-host")}
      mobileLayout="panel"
      className="workspace-settings translate-none"
      overlayClassName="settings-backdrop"
      data-sidebar={sidebarState}
      data-settings-index
      data-settings-route={root.id}
      data-settings-frontmost={depth === 1}
      data-settings-scope={global ? "personal" : "agent"}
      finalFocus={() => document.getElementById("main-content")}
    >
      {!mobile && <SettingsPageHeader frame={root} context={context} />}
      <SettingsNavigation
        root={root}
        selected={active}
        global={global}
        context={context}
        rows={rows.current}
      />
      {mobile && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="settings-root-close"
          aria-label="Close settings"
          disabled={context.locked}
          onClick={() => context.exit()}
        >
          <X />
        </Button>
      )}
      {frames[1] && (
        <SettingsLayer
          key={frames[1].id}
          frames={frames}
          index={1}
          depth={depth}
          context={context}
          onClosed={onLayerClosed}
          returnFocus={() => rows.current.get(frames[1]!.category) ?? null}
        />
      )}
    </DialogContent>
  )
}

function SettingsNavigation({
  root,
  selected,
  global,
  context,
  rows,
  dialogTitle = true,
}: {
  root: SettingsFrame
  selected: SettingsFrame
  global: boolean
  context: StackContext
  rows?: Map<string, HTMLElement>
  dialogTitle?: boolean
}) {
  const { family } = useFamily()
  const { data: session } = authClient.useSession()
  const mobile = useOverlayMobile()
  const agent = context.props.agent
  const sections = global
    ? personalSections.filter(
        (item) => item.id !== "channels" || family.role === "owner"
      )
    : agentSections
  const groups = global
    ? [
        sections.filter((item) => item.id === "account"),
        sections.filter(
          (item) =>
            item.id !== "account" &&
            item.id !== "family" &&
            item.id !== "model-access"
        ),
        sections.filter(
          (item) => item.id === "family" || item.id === "model-access"
        ),
      ]
    : [sections]
  const active = context.location.settingsFrames.some(
    (frame) => frame.id === root.id
  )
  const destinations = useRef(
    new Map<string, ReturnType<Location["settingsLink"]>>()
  )
  if (active)
    for (const item of sections)
      destinations.current.set(
        item.id,
        context.location.settingsLink(item.id, root)
      )
  return (
    <aside className="settings-navigation">
      <div className="settings-agent">
        {global ? (
          <>
            <UserAvatar
              name={session?.user.name ?? "Account"}
              image={session?.user.image}
            />
            <span>{session?.user.name ?? "Account"}</span>
          </>
        ) : (
          agent && (
            <>
              <AgentAvatar
                name={agent.id}
                label={agent.name}
                aria-hidden="true"
              />
              <span>{agent.name}</span>
            </>
          )
        )}
      </div>
      <div className="settings-nav-content">
        {dialogTitle ? (
          <DialogTitle className="settings-title">
            {global ? "Settings" : "Assistant settings"}
          </DialogTitle>
        ) : (
          <h2 className="settings-title">
            {global ? "Settings" : "Assistant settings"}
          </h2>
        )}
        <nav aria-label="Settings sections">
          {groups.map((group) => (
            <div className="settings-nav-group" key={group[0]!.id}>
              {group.map((item) => (
                <Link
                  {...(destinations.current.get(item.id) ?? {
                    to: "/settings" as const,
                  })}
                  ref={(element) => {
                    if (element) rows?.set(item.id, element)
                    else rows?.delete(item.id)
                  }}
                  data-slot="button"
                  data-account-row={mobile && global && item.id === "account"}
                  className={buttonVariants({
                    variant: "ghost",
                    className: "settings-nav-item",
                  })}
                  key={item.id}
                  aria-label={item.title}
                  aria-current={
                    selected.category === item.id ? "page" : undefined
                  }
                  disabled={context.locked || !active}
                >
                  {mobile && global && item.id === "account" ? (
                    <UserAvatar
                      name={session?.user.name ?? "Account"}
                      image={session?.user.image}
                    />
                  ) : (
                    <item.icon />
                  )}
                  <span>
                    <strong>
                      {mobile && global && item.id === "account"
                        ? (session?.user.name ?? "Account")
                        : item.title}
                    </strong>
                    {mobile && global && item.id === "account" && (
                      <small>Account</small>
                    )}
                  </span>
                  <ChevronRight />
                </Link>
              ))}
            </div>
          ))}
        </nav>
      </div>
    </aside>
  )
}

function SettingsLayer({
  frames,
  index,
  depth,
  context,
  onClosed,
  returnFocus,
}: {
  frames: readonly SettingsFrame[]
  index: number
  depth: number
  context: StackContext
  onClosed: (id: string) => void
  returnFocus?: () => HTMLElement | null
}) {
  const frame = frames[index]!
  const parent = frames[index - 1]!
  const mobile = useOverlayMobile()
  const { state: sidebarState } = useSidebar()
  const global = isGlobalSettingsSection(frame.category)
  const dismiss = () =>
    mobile ? context.location.popSettings() : context.exit()
  const [entered, setEntered] = useState(false)
  useEffect(() => setEntered(true), [])
  const open = entered && index < depth
  const title = frameTitle(frame)
  const body = useRef<HTMLDivElement>(null)
  const trigger = useRef(
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  )
  return (
    <Dialog
      desktop="page"
      modal={index === depth - 1}
      open={open}
      dismissible={!context.locked && index === depth - 1}
      onOpenChange={(next) => {
        if (!next && index === depth - 1) dismiss()
      }}
      onOpenChangeComplete={(next) => {
        if (!next && entered) onClosed(frame.id)
      }}
    >
      <DialogContent
        container={document.getElementById("settings-page-host")}
        showCloseButton={false}
        mobileLayout="panel"
        className="workspace-settings settings-route-drawer translate-none"
        overlayClassName="settings-backdrop"
        data-sidebar={sidebarState}
        data-settings-route={frame.id}
        data-settings-frontmost={index === depth - 1}
        data-settings-scope={global ? "personal" : "agent"}
        data-family={
          !mobile &&
          (frame.category === "family" || frame.category === "model-access")
        }
        finalFocus={() =>
          !mobile
            ? document.getElementById("main-content")
            : trigger.current?.isConnected &&
                trigger.current
                  .closest("[data-settings-route]")
                  ?.getAttribute("data-settings-route") === parent.id
              ? trigger.current
              : (returnFocus?.() ?? null)
        }
        ref={body}
      >
        {!mobile && <SettingsPageHeader frame={frame} context={context} />}
        <DialogTitle render={<span />} className="sr-only">
          {mobile ? title : global ? "Settings" : "Assistant settings"}
        </DialogTitle>
        {!mobile && (
          <SettingsNavigation
            root={frames[0]!}
            selected={frame}
            global={global}
            context={context}
            dialogTitle={false}
          />
        )}
        <SettingsDetail
          key="detail"
          frame={frame}
          parent={parent}
          context={context}
          mobile={mobile}
          onDismiss={dismiss}
        />
        {frames[index + 1] && (
          <SettingsLayer
            key={frames[index + 1]!.id}
            frames={frames}
            index={index + 1}
            depth={depth}
            context={context}
            onClosed={onClosed}
            returnFocus={() => body.current}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function SettingsPageHeader({
  frame,
  context,
}: {
  frame: SettingsFrame
  context: StackContext
}) {
  const global = isGlobalSettingsSection(frame.category)
  return (
    <header className="settings-page-header">
      <SidebarTrigger size="icon-sm" />
      <span className="settings-page-divider" aria-hidden="true" />
      <nav
        aria-label="Breadcrumb"
        className="flex min-w-0 items-center gap-3 text-sm"
      >
        <span className="truncate text-muted-foreground">
          {global
            ? "Settings"
            : (context.props.agent?.name ?? "Assistant settings")}
        </span>
        {frame.category !== "settings" &&
          frame.category !== "agent-settings" && (
            <>
              <ChevronRight
                className="size-3 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span aria-current="page">{frameTitle(frame)}</span>
            </>
          )}
      </nav>
      <Button
        variant="ghost"
        size="icon-sm"
        className="ml-auto"
        aria-label="Back to workspace"
        title="Back to workspace"
        disabled={context.locked}
        onClick={() => context.exit()}
      >
        <ArrowLeft />
      </Button>
    </header>
  )
}

function SettingsDetail({
  frame,
  parent,
  context,
  mobile,
  onDismiss,
}: {
  frame: SettingsFrame
  parent?: SettingsFrame
  context: StackContext
  mobile: boolean
  onDismiss: () => void
}) {
  return (
    <div className="settings-detail">
      {mobile && (
        <div className="settings-detail-bar">
          {parent && (
            <Button
              variant="ghost"
              size="sm"
              aria-label={"Back to " + frameTitle(parent)}
              disabled={context.locked}
              onClick={onDismiss}
            >
              <ArrowLeft data-icon="inline-start" />
              {frameTitle(parent)}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label={"Close " + frameTitle(frame)}
            disabled={context.locked}
            onClick={onDismiss}
          >
            <X />
          </Button>
        </div>
      )}
      <div className="settings-detail-content">
        <SettingsBody frame={frame} context={context} onDismiss={onDismiss} />
      </div>
      {context.locked && (
        <p role="status" className="settings-draft-notice">
          Finish or cancel your changes before leaving this section.
        </p>
      )}
    </div>
  )
}

function SettingsBody({
  frame,
  context,
  onDismiss,
}: {
  frame: SettingsFrame
  context: StackContext
  onDismiss: () => void
}) {
  const { props, location, pending } = context
  const report = useCallback(
    (value: boolean) => pending(frame.id, value),
    [pending, frame.id]
  )
  useEffect(() => () => report(false), [report])
  const active = location.settingsFrames.at(-1)?.id === frame.id
  const update = location.update
  const consumeCallback = useCallback(() => {
    if (active) update({ connections: undefined }, true)
  }, [active, update])
  const change = (category: SettingsCategory | null) => {
    if (category) location.pushSettings(category, frame)
    else onDismiss()
  }
  return isGlobalSettingsSection(frame.category) ? (
    <PersonalSettings
      category={frame.category}
      agents={props.agents}
      onPendingChange={report}
      onCategoryChange={change}
      connectionResult={active ? location.search.connections : undefined}
      onConnectionResultConsumed={consumeCallback}
    />
  ) : (
    props.agent && (
      <AgentSettings
        category={frame.category}
        agent={props.agent}
        conversation={props.conversation}
        onPendingChange={report}
        onEdit={() => context.exit(() => location.openEditor(props.agent!.id))}
        onManageConnections={() => change("connection-library")}
        onManageSkills={() => change("skill-library")}
        onModelAccess={() => change("model-access")}
        onWorkbench={(panel) => context.exit(() => props.onWorkbench(panel))}
      />
    )
  )
}

function PersonalSettings({
  category,
  agents,
  onPendingChange,
  onCategoryChange,
  connectionResult,
  onConnectionResultConsumed,
}: {
  category: SettingsCategory | null
  agents: readonly AgentProfile[]
  onPendingChange: (value: boolean) => void
  onCategoryChange: (category: SettingsCategory | null) => void
  connectionResult?: "connected" | "failed"
  onConnectionResultConsumed: () => void
}) {
  const { family } = useFamily()
  if (category === "account")
    return (
      <section className="settings-section">
        <header className="settings-section-heading">
          <h2>Account</h2>
        </header>
        <div className="settings-section-body">
          <ProfilePhoto onPendingChange={onPendingChange} />
        </div>
      </section>
    )
  if (category === "preferences") return <Preferences />
  if (category === "security")
    return (
      <AccountSecurity
        embedded
        onClose={() => onCategoryChange(null)}
        onPendingChange={onPendingChange}
      />
    )
  if (category === "family")
    return (
      <FamilySettings
        onPendingChange={onPendingChange}
        onModelAccess={() => onCategoryChange("model-access")}
      />
    )
  if (category === "model-access")
    return <ModelAccess onPendingChange={onPendingChange} />
  if (category === "connection-library")
    return (
      <ConnectionsPanel
        embedded
        open
        onOpenChange={() => {}}
        onSaved={() => {}}
        callbackResult={connectionResult}
        onCallbackConsumed={onConnectionResultConsumed}
        onPendingChange={onPendingChange}
      />
    )
  if (category === "skill-library")
    return (
      <SkillsPanel
        embedded
        open
        onOpenChange={() => {}}
        onPendingChange={onPendingChange}
      />
    )
  if (category === "channels")
    return family.role === "owner" ? (
      <ChannelSettings agents={agents} onPendingChange={onPendingChange} />
    ) : (
      <p className="p-6">Only the family admin can manage channels.</p>
    )
  return null
}

function Preferences() {
  const sound = useInteractionSoundPreference()
  const playInteractionSound = useInteractionSound()
  return (
    <section className="settings-section">
      <header className="settings-section-heading">
        <h2>Preferences</h2>
      </header>
      <div className="settings-section-body settings-preferences-body">
        <CardFrame className="settings-preferences-frame">
          <Card className="settings-preferences-card">
            <AppearanceSettings />
            <MessageDeliverySettings />
            <div className="settings-preference">
              <div>
                <h3>Interaction sounds</h3>
                <p>Play a click when copying or showing passwords.</p>
              </div>
              <div className="settings-preference-actions">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void playInteractionSound({ preview: true })}
                >
                  <Play data-icon="inline-start" />
                  Test sound
                </Button>
                <Switch
                  aria-label="Interaction sounds"
                  checked={sound.enabled}
                  onCheckedChange={sound.setEnabled}
                />
              </div>
            </div>
          </Card>
          <CardFrameFooter>On this device.</CardFrameFooter>
        </CardFrame>
      </div>
    </section>
  )
}

function AgentSettings({
  category,
  agent,
  conversation,
  onPendingChange,
  onEdit,
  onManageConnections,
  onManageSkills,
  onModelAccess,
  onWorkbench,
}: {
  category: SettingsCategory | null
  agent: AgentProfile
  conversation: ReturnType<typeof useConversation>
  onPendingChange: (value: boolean) => void
  onEdit: () => void
  onManageConnections: () => void
  onManageSkills: () => void
  onModelAccess: () => void
  onWorkbench: (panel: Workbench) => void
}) {
  const { family } = useFamily()
  const { state, reload } = conversation
  if (category === "general")
    return (
      <section className="settings-section">
        <header className="settings-section-heading">
          <h2>General</h2>
        </header>
        <div className="settings-section-body">
          <CardFrame>
            <Card className="settings-agent-summary">
              <div className="settings-preference">
                <div>
                  <h3>{agent.name}</h3>
                  <p>{agent.instructions || "Your personal assistant"}</p>
                </div>
                <Button variant="outline" size="sm" onClick={onEdit}>
                  Edit assistant
                </Button>
              </div>
            </Card>
          </CardFrame>
          {family.role === "owner" && (
            <EmailSettings
              agentId={agent.id}
              archived={agent.status === "archived"}
              onPendingChange={onPendingChange}
            />
          )}
        </div>
      </section>
    )
  if (category === "models")
    return state ? (
      <ModelDefaults
        agentId={agent.id}
        selection={{
          model: state.model,
          thinking: Schema.is(ThinkingLevel)(state.thinking)
            ? state.thinking
            : "medium",
          settingsRevision: state.settingsRevision ?? 0,
        }}
        onSaved={reload}
        onPendingChange={onPendingChange}
        onModelAccess={onModelAccess}
      />
    ) : (
      <DataLoading
        loading
        label="Loading model settings"
        layout="form"
        className="p-6"
      />
    )
  if (category === "connections")
    return (
      <ConnectionsPanel
        embedded
        open
        agentId={agent.id}
        agentName={agent.name}
        onOpenChange={() => {}}
        onSaved={reload}
        onPendingChange={onPendingChange}
        onCallbackConsumed={() => {}}
        onManageLibrary={onManageConnections}
      />
    )
  if (category === "skills")
    return (
      <SkillsPanel
        embedded
        open
        agentId={agent.id}
        agentName={agent.name}
        onOpenChange={() => {}}
        onPendingChange={onPendingChange}
        onManageLibrary={onManageSkills}
      />
    )
  if (category === "access")
    return (
      <>
        <div className="settings-network-link">
          <Globe />
          <span>Browser and terminal internet access</span>
          <Button
            size="sm"
            variant="link"
            onClick={() => onWorkbench("browser")}
          >
            Browser
          </Button>
          <Button
            size="sm"
            variant="link"
            onClick={() => onWorkbench("terminal")}
          >
            Terminal
          </Button>
        </div>
        <AccessPanel
          embedded
          open
          agentId={agent.id}
          agentName={agent.name}
          onOpenChange={() => {}}
          onSaved={reload}
          onPendingChange={onPendingChange}
        />
      </>
    )
  return null
}
