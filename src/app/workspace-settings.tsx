import { Link } from "@tanstack/react-router"
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
  Volume2,
  X,
  Users,
  User,
  MessageCircle,
} from "lucide-react"
import { useCallback, useEffect, useState } from "react"

import type { AgentProfile } from "@/agents/contracts"
import { authClient } from "@/auth/client"
import { AgentMark, agentTone } from "@/components/agent-mark"
import { Button, buttonVariants } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { useSidebar } from "@/components/ui/sidebar"
import { Switch } from "@/components/ui/switch"
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
import {
  workspaceDestination,
  globalSettingsLink,
  isGlobalSettingsSection,
} from "@/navigation/workspace"
import type { SettingsCategory } from "@/navigation/workspace"

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

export function WorkspaceSettings({
  category,
  onCategoryChange,
  agent,
  agents,
  conversation,
  onPendingChange,
  onWorkbench,
}: {
  category: SettingsCategory | null
  onCategoryChange: (category: SettingsCategory | null) => void
  agent?: AgentProfile
  agents: readonly AgentProfile[]
  conversation: ReturnType<typeof useConversation>
  onPendingChange: (pending: boolean) => void
  onWorkbench: (workbench: Workbench) => void
}) {
  const location = useWorkspaceLocation(agent ? [agent] : [], agent)
  const { family } = useFamily()
  const { data: session } = authClient.useSession()
  const [locked, setLocked] = useState(false)
  const global = isGlobalSettingsSection(category ?? undefined)
  const mobileDetail = location.search.settingsView !== "sections"
  const { state: sidebarState } = useSidebar()
  const { update } = location
  const consumeConnectionCallback = useCallback(
    () => update({ connections: undefined }, true),
    [update]
  )
  useEffect(() => {
    onPendingChange(locked)
    return () => onPendingChange(false)
  }, [locked, onPendingChange])
  function close() {
    if (!locked) onCategoryChange(null)
  }
  return (
    <Dialog
      open={category !== null}
      dismissible={!locked}
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent
        showCloseButton={false}
        mobileLayout="panel"
        className="workspace-settings translate-none"
        overlayClassName="settings-backdrop"
        data-detail={mobileDetail}
        data-sidebar={sidebarState}
        data-family={category === "family" || category === "model-access"}
        data-settings-scope={global ? "personal" : "agent"}
      >
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
                  <AgentMark tone={agentTone(agent.id)} />
                  <span>{agent.name}</span>
                </>
              )
            )}
          </div>
          <div className="settings-nav-content">
            <DialogTitle className="settings-title">
              {global ? "Settings" : "Agent settings"}
            </DialogTitle>
            <nav aria-label="Settings sections">
              {(global
                ? personalSections.filter(
                    (item) => item.id !== "channels" || family.role === "owner"
                  )
                : agentSections
              ).map((item) => (
                <Link
                  {...(isGlobalSettingsSection(item.id)
                    ? globalSettingsLink(item.id, {
                        returnTo: location.search.returnTo,
                      })
                    : workspaceDestination(agent!.slug, {
                        ...location.search,
                        settings: item.id,
                        security: undefined,
                        settingsView: undefined,
                        connections: undefined,
                      }))}
                  data-slot="button"
                  className={buttonVariants({
                    variant: "ghost",
                    className: "settings-nav-item",
                  })}
                  key={item.id}
                  aria-current={category === item.id ? "page" : undefined}
                  disabled={locked}
                >
                  <item.icon />
                  <span>
                    <strong>{item.title}</strong>
                  </span>
                  <ChevronRight />
                </Link>
              ))}
            </nav>
          </div>
        </aside>
        <div className="settings-detail">
          <div className="settings-detail-bar">
            <Button
              variant="ghost"
              size="icon-sm"
              className="settings-back"
              aria-label="All settings"
              disabled={locked}
              onClick={() => update({ settingsView: "sections" })}
            >
              <ArrowLeft />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-auto"
              aria-label="Close settings"
              disabled={locked}
              onClick={close}
            >
              <X />
            </Button>
          </div>
          <div className="settings-detail-content">
            {global ? (
              <PersonalSettings
                key={category}
                category={category}
                agents={agents}
                onPendingChange={setLocked}
                onCategoryChange={onCategoryChange}
                connectionResult={location.search.connections}
                onConnectionResultConsumed={consumeConnectionCallback}
              />
            ) : (
              agent && (
                <AgentSettings
                  key={agent.id + ":" + category}
                  category={category}
                  agent={agent}
                  conversation={conversation}
                  onPendingChange={setLocked}
                  onEdit={() => location.openEditor(agent.id)}
                  onManageConnections={() =>
                    onCategoryChange("connection-library")
                  }
                  onManageSkills={() => onCategoryChange("skill-library")}
                  onModelAccess={() => onCategoryChange("model-access")}
                  onWorkbench={(panel) => {
                    if (!locked) onWorkbench(panel)
                  }}
                />
              )
            )}
          </div>
          {locked && (
            <p role="status" className="settings-draft-notice">
              Finish or cancel your changes before leaving this section.
            </p>
          )}
        </div>
        {!mobileDetail && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="settings-mobile-close"
            aria-label="Close settings"
            disabled={locked}
            onClick={close}
          >
            <X />
          </Button>
        )}
      </DialogContent>
    </Dialog>
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
      <div className="settings-section-body">
        <AppearanceSettings />
        <MessageDeliverySettings />
        <div className="settings-preference">
          <Volume2 />
          <div>
            <h3>Interaction sounds</h3>
            <p>Play a click when copying or showing passwords.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => void playInteractionSound({ preview: true })}
            >
              <Play data-icon="inline-start" />
              Test sound
            </Button>
          </div>
          <Switch
            aria-label="Interaction sounds"
            checked={sound.enabled}
            onCheckedChange={sound.setEnabled}
          />
        </div>
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
          <div className="settings-preference">
            <div>
              <h3>{agent.name}</h3>
              <p>{agent.instructions || "Your personal assistant"}</p>
            </div>
            <Button variant="outline" size="sm" onClick={onEdit}>
              Edit agent
            </Button>
          </div>
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
      <p className="p-6 text-sm">Loading model settings…</p>
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
