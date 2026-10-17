import { Link } from "@tanstack/react-router"
import { Schema } from "effect"
import {
  ArrowLeft,
  ArrowUpRight,
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
} from "lucide-react"
import { useEffect, useState } from "react"

import type { AgentProfile } from "@/agents/contracts"
import { AgentMark, agentTone } from "@/components/agent-mark"
import { Button, buttonVariants } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { useSidebar } from "@/components/ui/sidebar"
import { Switch } from "@/components/ui/switch"
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
import { WhatsAppSettings } from "@/features/whatsapp/whatsapp-settings"
import { useInteractionSoundPreference } from "@/hooks/interaction-sound-preference"
import { useInteractionSound } from "@/hooks/use-interaction-sound"
import { ThinkingLevel } from "@/inference/selection"
import { workspaceDestination } from "@/navigation/workspace"
import type { SettingsCategory } from "@/navigation/workspace"

import { useWorkspaceLocation } from "./use-workspace-location"
import type { Workbench } from "./workspace-navigation"

const settingsSections = [
  {
    id: "general",
    title: "General",
    description: "Appearance, messages and security",
    icon: Settings2,
  },
  {
    id: "models",
    title: "Models & connections",
    description: "Subscription and job defaults",
    icon: Plug,
  },
  {
    id: "access",
    title: "Agents & tools",
    description: "Capabilities and permissions",
    icon: ShieldCheck,
  },
  {
    id: "skills",
    title: "Skills",
    description: "Instructions and revisions",
    icon: BookOpen,
  },
  {
    id: "family",
    title: "Family",
    description: "People and invitations",
    icon: Users,
  },
  {
    id: "model-access",
    title: "Model access",
    description: "Shared ChatGPT connection",
    icon: Plug,
  },
  {
    id: "memory",
    title: "Memory & data",
    description: "Notes, original sources and files",
    icon: BookOpen,
  },
] as const
export type { SettingsCategory } from "@/navigation/workspace"

export function WorkspaceSettings({
  category,
  connectionResult,
  onConnectionResultConsumed,
  onCategoryChange,
  agent,
  conversation,
  onPendingChange,
  securityOpen,
  onSecurityOpenChange,
  onWorkbench,
}: {
  connectionResult?: "connected" | "failed"
  onConnectionResultConsumed: () => void
  category: SettingsCategory | null
  onCategoryChange: (category: SettingsCategory | null) => void
  agent: AgentProfile
  conversation: ReturnType<typeof useConversation>
  onPendingChange: (pending: boolean) => void
  securityOpen: boolean
  onSecurityOpenChange: (open: boolean) => void
  onWorkbench: (workbench: Workbench) => void
}) {
  const location = useWorkspaceLocation()
  const { family } = useFamily()
  const [familyPending, setFamilyPending] = useState(false)
  const [securityPending, setSecurityPending] = useState(false)
  const [profilePending, setProfilePending] = useState(false)
  const [modelsPending, setModelsPending] = useState(false)
  const [accessPending, setAccessPending] = useState(false)
  const [connectionsPending, setConnectionsPending] = useState(false)
  const [skillsPending, setSkillsPending] = useState(false)
  const [emailPending, setEmailPending] = useState(false)
  const [whatsappPending, setWhatsAppPending] = useState(false)
  const mobileDetail = location.search.settingsView !== "sections"
  const setMobileDetail = (detail: boolean) =>
    location.update({ settingsView: detail ? undefined : "sections" })
  const sound = useInteractionSoundPreference()
  const playInteractionSound = useInteractionSound()
  const { state: sidebarState } = useSidebar()
  const locked = [
    familyPending,
    modelsPending,
    accessPending,
    connectionsPending,
    skillsPending,
    emailPending,
    whatsappPending,
    profilePending,
    securityPending,
  ].some(Boolean)
  useEffect(() => {
    onPendingChange(locked)
  }, [locked, onPendingChange])
  function close() {
    if (!locked) {
      onCategoryChange(null)
    }
  }
  function leave(action: () => void) {
    if (!locked) {
      close()
      action()
    }
  }
  const section = settingsSections.find(
    (item) => item.id === (category === "connections" ? "models" : category)
  )
  const { state, reload } = conversation
  return (
    <Dialog
      open={category !== null}
      modal={!securityOpen}
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
      >
        <aside className="settings-navigation">
          <div className="settings-agent">
            <AgentMark tone={agentTone(agent.id)} />
            <span>{agent.name}</span>
          </div>
          <div className="settings-nav-content">
            <DialogTitle className="settings-title">Settings</DialogTitle>
            <nav aria-label="Settings sections">
              {settingsSections.map((item) => (
                <Link
                  {...workspaceDestination(agent.id, {
                    ...location.search,
                    settings: item.id,
                    security: undefined,
                    settingsView: undefined,
                    connections: undefined,
                  })}
                  data-slot="button"
                  className={buttonVariants({
                    variant: "ghost",
                    className: "settings-nav-item",
                  })}
                  key={item.id}
                  aria-current={section?.id === item.id ? "page" : undefined}
                  disabled={locked}
                >
                  <item.icon />
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.description}</small>
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
              onClick={() => setMobileDetail(false)}
            >
              <ArrowLeft />
            </Button>
            {category === "models" || category === "connections" ? (
              <div
                className="settings-subnav"
                aria-label="Models and connections"
              >
                <Link
                  {...workspaceDestination(agent.id, {
                    ...location.search,
                    settings: "models",
                    security: undefined,
                    settingsView: undefined,
                    connections: undefined,
                  })}
                  data-slot="button"
                  className={buttonVariants({
                    variant: category === "models" ? "secondary" : "ghost",
                    size: "sm",
                  })}
                  disabled={locked}
                >
                  Models
                </Link>
                <Link
                  {...workspaceDestination(agent.id, {
                    ...location.search,
                    settings: "connections",
                    security: undefined,
                    settingsView: undefined,
                    connections: undefined,
                  })}
                  data-slot="button"
                  className={buttonVariants({
                    variant: category === "connections" ? "secondary" : "ghost",
                    size: "sm",
                  })}
                  disabled={locked}
                >
                  Connected tools
                </Link>
              </div>
            ) : null}
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
            {category === "family" && (
              <FamilySettings
                onPendingChange={setFamilyPending}
                onModelAccess={() => onCategoryChange("model-access")}
              />
            )}
            {category === "model-access" && <ModelAccess />}
            <section
              hidden={category !== "general"}
              className="settings-section"
            >
              <header className="settings-section-heading">
                <h2>General</h2>
              </header>
              <div className="settings-section-body">
                <ProfilePhoto onPendingChange={setProfilePending} />
                <Separator />
                <div className="settings-preference">
                  <div>
                    <h3>{agent.name}</h3>
                    <p>{agent.instructions || "Your personal assistant"}</p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => location.openEditor(agent.id)}
                  >
                    Edit agent
                  </Button>
                </div>
                <AppearanceSettings />
                <MessageDeliverySettings />
                {family.role === "owner" && (
                  <EmailSettings
                    key={agent.id}
                    agentId={agent.id}
                    archived={agent.status === "archived"}
                    onPendingChange={setEmailPending}
                  />
                )}
                {family.role === "owner" && (
                  <WhatsAppSettings
                    key={`whatsapp-${agent.id}`}
                    agentId={agent.id}
                    agentName={agent.name}
                    archived={agent.status === "archived"}
                    open={category === "general"}
                    onPendingChange={setWhatsAppPending}
                  />
                )}
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
                      onClick={() =>
                        void playInteractionSound({ preview: true })
                      }
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
                <SettingsLink
                  title="Account security"
                  detail="Two-factor authentication, recovery codes and signed-in devices."
                  onClick={() => onSecurityOpenChange(true)}
                />
              </div>
            </section>
            <div
              hidden={category !== "models" && category !== "connections"}
              className="settings-models"
            >
              <div hidden={category !== "models"}>
                {state ? (
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
                    onPendingChange={setModelsPending}
                  />
                ) : (
                  <p className="p-6 text-sm">Loading model settings…</p>
                )}
              </div>
            </div>
            <ConnectionsPanel
              callbackResult={connectionResult}
              onCallbackConsumed={onConnectionResultConsumed}
              embedded
              agentId={agent.id}
              agentName={agent.name}
              open={category === "connections"}
              onOpenChange={(open) => {
                if (open) onCategoryChange("connections")
              }}
              onSaved={reload}
              onPendingChange={setConnectionsPending}
            />
            <div
              hidden={category !== "access"}
              className="settings-network-link"
            >
              <Globe />
              <span>Browser and terminal internet access</span>
              <Button
                size="sm"
                variant="link"
                disabled={locked}
                onClick={() => leave(() => onWorkbench("browser"))}
              >
                Browser
              </Button>
              <Button
                size="sm"
                variant="link"
                disabled={locked}
                onClick={() => leave(() => onWorkbench("terminal"))}
              >
                Terminal
              </Button>
            </div>
            <AccessPanel
              embedded
              agentId={agent.id}
              agentName={agent.name}
              open={category === "access"}
              onOpenChange={() => {}}
              onSaved={reload}
              onPendingChange={setAccessPending}
            />
            <SkillsPanel
              embedded
              agentId={agent.id}
              agentName={agent.name}
              open={category === "skills"}
              onOpenChange={() => {}}
              onPendingChange={setSkillsPending}
            />
            <section
              hidden={category !== "memory"}
              className="settings-section"
            >
              <header className="settings-section-heading">
                <h2>Memory & data</h2>
                <p>{agent.name} keeps its own memory and files.</p>
              </header>
              <div className="settings-section-body">
                <SettingsLink
                  title="Memory"
                  detail="Read saved notes and find their original sources."
                  onClick={() => leave(() => onWorkbench("memory"))}
                />
                <SettingsLink
                  title="Files"
                  detail="View, download or restore this agent’s files."
                  onClick={() => leave(() => onWorkbench("files"))}
                />
                <SettingsLink
                  title="Checklists"
                  detail="Open working objects and their change history."
                  onClick={() => leave(() => onWorkbench("objects"))}
                />
              </div>
            </section>
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
            onClick={close}
          >
            <X />
          </Button>
        )}
      </DialogContent>
      {securityOpen && (
        <AccountSecurity
          onClose={() => onSecurityOpenChange(false)}
          onPendingChange={setSecurityPending}
        />
      )}
    </Dialog>
  )
}
function SettingsLink({
  title,
  detail,
  onClick,
}: {
  title: string
  detail: string
  onClick: () => void
}) {
  return (
    <Button variant="ghost" className="settings-link" onClick={onClick}>
      <span>
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      <ArrowUpRight />
    </Button>
  )
}
