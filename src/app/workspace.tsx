import { WorkbenchPanel } from "./workbench"
import { MobileNavigation } from "./mobile-navigation"
import { useFiles, FilesWorkbench } from "@/features/files"
import { MemoryWorkbench } from "@/features/memory"
import {
  WorkspaceNavigation,
  type Workbench,
  type WorkspaceAction,
} from "./workspace-navigation"
import { RoutinesWorkbench } from "@/features/routines"
import { ActivityWorkbench } from "@/features/activity"
import { useEffect, useState } from "react"
import { ObjectsProvider, ObjectsWorkbench } from "@/features/objects"
import { PanelRight } from "lucide-react"
import { TerminalWorkbench } from "@/features/terminal"
import { AppsWorkbench } from "@/features/apps"
import { ExecutionWorkbench } from "@/features/execution"
import { BrowserWorkbench } from "@/features/browser"
import { authClient } from "@/auth/client"
import { AccountSecurity, Login, PiMark } from "@/features/auth"
import { Conversation, useConversation } from "@/features/conversation"
import { AgentEditor, AgentSidebar, useAgentCatalog } from "@/features/agents"
import type { AgentProfile } from "@/agents/contracts"
import { api } from "@/http/client"
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"

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
  return (
    <Workspace
      key={session.user.id}
      ownerId={session.user.id}
      name={session.user.name}
    />
  )
}
function Workspace({ ownerId, name }: { ownerId: string; name: string }) {
  const catalog = useAgentCatalog(ownerId)
  const [securityOpen, setSecurityOpen] = useState(false)
  const [navigationLocked, setNavigationLocked] = useState(false)
  const [workbench, setWorkbench] = useState<Workbench | null>(null)
  useEffect(() => {
    // Paper's desktop opens with the work beside the conversation. Phones start in chat.
    if (window.matchMedia("(min-width: 1024px)").matches) setWorkbench("apps")
  }, [])
  function selectAgent(id: AgentProfile["id"]) {
    if (navigationLocked) return
    if (id !== catalog.selected?.id) setWorkbench(null)
    catalog.select(id)
  }
  const [editor, setEditor] = useState<{
    agent?: AgentProfile
    key: string
  } | null>(null)
  const [error, setError] = useState("")
  async function archive(agent: AgentProfile) {
    if (navigationLocked) return
    try {
      await api("/api/agent/bots/archive", {
        id: agent.id,
        archived: agent.status === "active",
      })
      await catalog.refresh()
      setError("")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not archive this agent.")
    }
  }
  function act(action: WorkspaceAction) {
    if (navigationLocked) return
    if (action === "create") setEditor({ key: crypto.randomUUID() })
    else if (action === "edit" && catalog.selected)
      setEditor({ key: catalog.selected.id, agent: catalog.selected })
    else if (action === "archive" && catalog.selected)
      void archive(catalog.selected)
    else if (action === "security") setSecurityOpen(true)
    else if (action === "sign-out") void authClient.signOut()
    else if (action === "hide-workbench") setWorkbench(null)
    else if (
      [
        "browser",
        "code",
        "apps",
        "terminal",
        "routines",
        "objects",
        "activity",
        "files",
        "memory",
      ].includes(action) &&
      catalog.selected
    )
      setWorkbench(action as Workbench)
  }
  return (
    <TooltipProvider>
      <SidebarProvider
        className="workspace-shell"
        style={{ "--sidebar-width": "224px" } as React.CSSProperties}
      >
        <WorkspaceNavigation
          name={name}
          agents={catalog.agents}
          selected={catalog.selected}
          locked={navigationLocked}
          workbench={workbench}
          onAction={act}
          onSelect={selectAgent}
        />
        <div className="workspace-body">
          <AgentSidebar
            disabled={navigationLocked}
            agents={catalog.agents}
            selected={catalog.selected}
            name={name}
            onSelect={selectAgent}
            onSecurity={() => act("security")}
            onActivity={() => act("activity")}
            onMemory={() => act("memory")}
            onCreate={() => {
              if (!navigationLocked) setEditor({ key: crypto.randomUUID() })
            }}
            onEdit={(agent) => {
              if (!navigationLocked) setEditor({ key: agent.id, agent })
            }}
            onArchive={(agent) => void archive(agent)}
          />
          <main className="workspace-main">
            {(error || catalog.error) && (
              <Alert>
                <AlertDescription className="flex items-center justify-between">
                  {error || catalog.error}
                  <Button
                    variant="ghost"
                    onClick={() =>
                      void catalog
                        .refresh()
                        .then(() => setError(""))
                        .catch(() =>
                          setError("Could not reconnect. Try again.")
                        )
                    }
                  >
                    Retry
                  </Button>
                </AlertDescription>
              </Alert>
            )}
            {catalog.selected ? (
              <AgentWorkspace
                key={catalog.selected.id}
                workbench={workbench}
                setWorkbench={setWorkbench}
                onNavigationLockChange={setNavigationLocked}
                name={name}
                agent={catalog.selected}
                agents={catalog.agents.filter(
                  (value) => value.status === "active"
                )}
                onOpenBot={selectAgent}
                onMemory={(id) => {
                  if (!navigationLocked) {
                    selectAgent(id)
                    setWorkbench("memory")
                  }
                }}
              />
            ) : (
              <div className="loading-view">
                <Skeleton className="h-6 w-44" />
                <p className="text-sm text-muted-foreground">
                  {catalog.loading
                    ? "Opening your workspace…"
                    : "Your workspace is unavailable."}
                </p>
              </div>
            )}
          </main>
        </div>
        {securityOpen && (
          <AccountSecurity onClose={() => setSecurityOpen(false)} />
        )}
        {editor && (
          <AgentEditor
            key={editor.key}
            open
            agent={editor.agent}
            onOpenChange={(open) => {
              if (!open) setEditor(null)
            }}
            onSaved={async (agent) => {
              await catalog.refresh()
              selectAgent(agent.id)
            }}
          />
        )}
      </SidebarProvider>
    </TooltipProvider>
  )
}

function AgentWorkspace({
  workbench,
  setWorkbench,
  agent,
  agents,
  onOpenBot,
  onMemory,
  name,
  onNavigationLockChange,
}: {
  workbench: Workbench | null
  setWorkbench: (value: Workbench | null) => void
  agent: AgentProfile
  agents: readonly AgentProfile[]
  onOpenBot: (id: AgentProfile["id"]) => void
  onMemory: (id: AgentProfile["id"]) => void
  name: string
  onNavigationLockChange: (value: boolean) => void
}) {
  const { setOpenMobile } = useSidebar()
  const conversation = useConversation(agent.id)
  const files = useFiles(agent.id)
  const [sending, setSending] = useState(false)
  const [appPending, setAppPending] = useState(false)
  const [objectId, setObjectId] = useState<string | null>(null)
  const [objectPending, setObjectPending] = useState(false)
  const [objectEditing, setObjectEditing] = useState(false)
  const [routinePending, setRoutinePending] = useState(false)
  useEffect(() => {
    onNavigationLockChange(
      objectPending || objectEditing || routinePending || appPending
    )
  }, [
    objectPending,
    objectEditing,
    routinePending,
    appPending,
    onNavigationLockChange,
  ])
  const locked = objectPending || objectEditing || routinePending || appPending
  const editingLocked = objectEditing || routinePending || appPending
  function openWorkbench(value: Workbench | null) {
    // Restored, unconfirmed object saves must remain reachable after a reload.
    if (!locked || (value === "objects" && !editingLocked)) setWorkbench(value)
  }
  function openAgents() {
    if (locked) return
    setWorkbench(null)
    setOpenMobile(true)
  }
  const mobileNavigation = (inWorkbench: boolean) => (
    <MobileNavigation
      workspace={inWorkbench}
      locked={locked}
      workspaceDisabled={
        inWorkbench && workbench === "objects" ? locked : editingLocked
      }
      onAgents={openAgents}
      onChat={() => openWorkbench(null)}
      onWorkspace={() =>
        openWorkbench(objectPending ? "objects" : (workbench ?? "files"))
      }
    />
  )
  return (
    <ObjectsProvider
      agentId={agent.id}
      archived={agent.status === "archived"}
      onPendingChange={setObjectPending}
      onOpen={(id) => {
        if (!objectEditing && !routinePending && !appPending) {
          setObjectId(id)
          setWorkbench("objects")
        }
      }}
    >
      <div className={`agent-columns ${workbench ? "workbench-visible" : ""}`}>
        <Conversation
          name={name}
          agent={agent}
          files={files}
          conversation={conversation}
          sending={sending}
          setSending={setSending}
          onOpenWorkbench={openWorkbench}
          workbenchAction={
            (!workbench ||
              (objectPending && !editingLocked && workbench !== "objects")) && (
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={editingLocked}
                aria-label={
                  objectPending ? "Recover checklist save" : "Open workbench"
                }
                onClick={() =>
                  openWorkbench(objectPending ? "objects" : "files")
                }
              >
                <PanelRight />
              </Button>
            )
          }
        />
        {workbench && (
          <WorkbenchPanel
            value={workbench}
            onChange={openWorkbench}
            agentName={agent.name}
            locked={locked}
            recoveryAction={
              objectPending && !editingLocked && workbench !== "objects" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openWorkbench("objects")}
                >
                  Recover checklist save
                </Button>
              ) : undefined
            }
            mobileNavigation={mobileNavigation(true)}
          >
            {workbench === "activity" && (
              <ActivityWorkbench
                agents={agents}
                onOpenBot={(id) => {
                  setWorkbench(null)
                  onOpenBot(id)
                }}
                onMemory={(id) => {
                  setWorkbench(null)
                  onMemory(id)
                }}
                agentId={agent.id}
                agentName={agent.name}
              />
            )}
            {workbench === "terminal" && (
              <TerminalWorkbench agentId={agent.id} agentName={agent.name} />
            )}
            {workbench === "routines" && (
              <RoutinesWorkbench
                onPendingChange={setRoutinePending}
                agentId={agent.id}
                agentName={agent.name}
              />
            )}
            {workbench === "objects" && (
              <ObjectsWorkbench
                selected={objectId}
                onSelect={setObjectId}
                agentName={agent.name}
                onEditing={setObjectEditing}
              />
            )}
            {workbench === "apps" && (
              <AppsWorkbench
                onOpenWorkbench={openWorkbench}
                onPendingChange={setAppPending}
                agentId={agent.id}
                agentName={agent.name}
              />
            )}
            {workbench === "code" && (
              <ExecutionWorkbench agentId={agent.id} agentName={agent.name} />
            )}
            {workbench === "browser" && (
              <BrowserWorkbench agentId={agent.id} agentName={agent.name} />
            )}
            {workbench === "files" && (
              <FilesWorkbench
                state={files}
                selectionDisabled={sending || files.uploading}
                onAttached={() => openWorkbench(null)}
              />
            )}
            {workbench === "memory" && (
              <MemoryWorkbench state={conversation.state} agentId={agent.id} />
            )}
          </WorkbenchPanel>
        )}
      </div>
      {mobileNavigation(false)}
    </ObjectsProvider>
  )
}
