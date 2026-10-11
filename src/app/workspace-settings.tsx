import { useEffect, useState } from "react"
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
} from "lucide-react"
import { Schema } from "effect"
import { ThinkingLevel } from "@/inference/selection"
import type { AgentProfile } from "@/agents/contracts"
import type { useConversation } from "@/features/conversation"
import { AccessPanel } from "@/features/access"
import { ConnectionsPanel } from "@/features/connections"
import { SkillsPanel } from "@/features/skills"
import { ModelDefaults } from "@/features/conversation/model-defaults"
import { AgentMark, agentTone } from "@/components/agent-mark"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { useSidebar } from "@/components/ui/sidebar"
import { Switch } from "@/components/ui/switch"
import { useInteractionSoundPreference } from "@/hooks/interaction-sound-preference"
import { useInteractionSound } from "@/hooks/use-interaction-sound"
import type { Workbench } from "./workspace-navigation"

const settingsSections = [
  {
    id: "general",
    title: "General",
    description: "Workspace, sounds and security",
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
    id: "memory",
    title: "Memory & data",
    description: "Notes, original sources and files",
    icon: BookOpen,
  },
] as const
export type SettingsCategory =
  (typeof settingsSections)[number]["id"] | "connections"

export function WorkspaceSettings({
  category,
  onCategoryChange,
  agent,
  conversation,
  onPendingChange,
  onEdit,
  onSecurity,
  onWorkbench,
}: {
  category: SettingsCategory | null
  onCategoryChange: (category: SettingsCategory | null) => void
  agent: AgentProfile
  conversation: ReturnType<typeof useConversation>
  onPendingChange: (pending: boolean) => void
  onEdit: () => void
  onSecurity: () => void
  onWorkbench: (workbench: Workbench) => void
}) {
  const [modelsPending, setModelsPending] = useState(false)
  const [accessPending, setAccessPending] = useState(false)
  const [connectionsPending, setConnectionsPending] = useState(false)
  const [skillsPending, setSkillsPending] = useState(false)
  const [mobileDetail, setMobileDetail] = useState(true)
  const sound = useInteractionSoundPreference()
  const playInteractionSound = useInteractionSound()
  const { state: sidebarState } = useSidebar()
  const locked =
    modelsPending || accessPending || connectionsPending || skillsPending
  useEffect(() => {
    onPendingChange(locked)
  }, [locked, onPendingChange])
  useEffect(() => {
    if (new URL(window.location.href).searchParams.has("connections"))
      onCategoryChange("connections")
  }, [onCategoryChange])
  function close() {
    if (!locked) {
      onCategoryChange(null)
      setMobileDetail(true)
    }
  }
  function navigate(value: SettingsCategory) {
    if (!locked) {
      onCategoryChange(value)
      setMobileDetail(true)
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
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="workspace-settings translate-none"
        overlayClassName="settings-backdrop"
        data-detail={mobileDetail}
        data-sidebar={sidebarState}
      >
        <aside className="settings-navigation">
          <div className="settings-agent">
            <AgentMark tone={agentTone(agent.id)} />
            <span>{agent.name}</span>
          </div>
          <div className="settings-nav-content">
            <DialogTitle className="settings-title">Settings</DialogTitle>
            <DialogDescription className="settings-description">
              Make this workspace your own.
            </DialogDescription>
            <nav aria-label="Settings sections">
              {settingsSections.map((item) => (
                <Button
                  key={item.id}
                  variant="ghost"
                  className="settings-nav-item"
                  aria-current={section?.id === item.id ? "page" : undefined}
                  disabled={locked}
                  onClick={() => navigate(item.id)}
                >
                  <item.icon />
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.description}</small>
                  </span>
                  <ChevronRight />
                </Button>
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
                <Button
                  size="sm"
                  variant={category === "models" ? "secondary" : "ghost"}
                  disabled={locked}
                  onClick={() => navigate("models")}
                >
                  Models
                </Button>
                <Button
                  size="sm"
                  variant={category === "connections" ? "secondary" : "ghost"}
                  disabled={locked}
                  onClick={() => navigate("connections")}
                >
                  Connected tools
                </Button>
              </div>
            ) : (
              <span>{section?.title ?? "Settings"}</span>
            )}
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
            <section
              hidden={category !== "general"}
              className="settings-section"
            >
              <header className="settings-section-heading">
                <h2>General</h2>
                <p>A few things that make this workspace yours.</p>
              </header>
              <div className="settings-section-body">
                <div className="settings-preference">
                  <div>
                    <h3>{agent.name}</h3>
                    <p>{agent.instructions || "Your personal assistant"}</p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => leave(onEdit)}
                  >
                    Edit agent
                  </Button>
                </div>
                <div className="settings-preference">
                  <Volume2 />
                  <div>
                    <h3>Interaction sounds</h3>
                    <p>
                      A short click when you copy a response or reveal or hide a
                      password. Remembered on this device.
                    </p>
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
                  onClick={() => leave(onSecurity)}
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
              embedded
              agentId={agent.id}
              agentName={agent.name}
              open={category === "connections"}
              onOpenChange={(open) => {
                if (open) navigate("connections")
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
              tools={state?.access?.tools}
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
