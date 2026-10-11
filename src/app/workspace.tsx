import {
  WorkspaceNavigation,
  type Workbench,
  type WorkspaceAction,
} from "./workspace-navigation"
import { RoutinesWorkbench } from "@/features/routines"
import { ActivityWorkbench } from "@/features/activity"
import { useCallback, useEffect, useState } from "react"
import { ObjectsProvider, ObjectsWorkbench } from "@/features/objects"
import {
  Globe,
  Code2,
  PanelsTopLeft,
  PanelRight,
  Clock3,
  TerminalSquare,
  ListTodo,
  Activity,
} from "lucide-react"
import { TerminalWorkbench } from "@/features/terminal"
import { AppsWorkbench } from "@/features/apps"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import { ExecutionWorkbench } from "@/features/execution"
import { BrowserWorkbench } from "@/features/browser"
import { authClient } from "@/auth/client"
import { Login, PiMark } from "@/features/auth"
import { Conversation } from "@/features/conversation"
import { AgentEditor, AgentSidebar, useAgentCatalog } from "@/features/agents"
import type { AgentProfile } from "@/agents/contracts"
import { api } from "@/http/client"
import { SidebarProvider } from "@/components/ui/sidebar"
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
  const [navigationLocked, setNavigationLocked] = useState(false)
  const [workbench, setWorkbench] = useState<Workbench | null>(null)
  function selectAgent(id: AgentProfile["id"]) {
    if (navigationLocked) return
    if (id !== catalog.selected?.id) setWorkbench(null)
    catalog.select(id)
  }
  const [memoryNavigation, setMemoryNavigation] = useState<{
    id: string
    request: string
  } | null>(null)
  const onMemoryOpened = useCallback((request: string) => {
    setMemoryNavigation((current) =>
      current?.request === request ? null : current
    )
  }, [])
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
    else if (action === "sign-out") void authClient.signOut()
    else if (action === "memory" && catalog.selected)
      setMemoryNavigation({
        id: catalog.selected.id,
        request: crypto.randomUUID(),
      })
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
                navigationLocked={navigationLocked}
                onNavigationLockChange={setNavigationLocked}
                name={name}
                agent={catalog.selected}
                agents={catalog.agents.filter(
                  (value) => value.status === "active"
                )}
                memoryRequest={
                  memoryNavigation?.id === catalog.selected.id
                    ? memoryNavigation.request
                    : undefined
                }
                onMemoryOpened={onMemoryOpened}
                onOpenBot={selectAgent}
                onMemory={(id) => {
                  if (!navigationLocked) {
                    selectAgent(id)
                    setMemoryNavigation({ id, request: crypto.randomUUID() })
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
  memoryRequest,
  onMemoryOpened,
  onOpenBot,
  onMemory,
  name,
  navigationLocked,
  onNavigationLockChange,
}: {
  workbench: Workbench | null
  setWorkbench: (value: Workbench | null) => void
  agent: AgentProfile
  agents: readonly AgentProfile[]
  memoryRequest?: string
  onMemoryOpened: (request: string) => void
  onOpenBot: (id: AgentProfile["id"]) => void
  onMemory: (id: AgentProfile["id"]) => void
  name: string
  navigationLocked: boolean
  onNavigationLockChange: (value: boolean) => void
}) {
  const [objectId, setObjectId] = useState<string | null>(null)
  const [objectPending, setObjectPending] = useState(false)
  const [objectEditing, setObjectEditing] = useState(false)
  const [routinePending, setRoutinePending] = useState(false)
  useEffect(() => {
    onNavigationLockChange(objectPending || objectEditing || routinePending)
  }, [objectPending, objectEditing, routinePending, onNavigationLockChange])
  const browserOpen = workbench === "browser"
  return (
    <ObjectsProvider
      agentId={agent.id}
      archived={agent.status === "archived"}
      onPendingChange={setObjectPending}
      onOpen={(id) => {
        if (!objectEditing && !routinePending) {
          setObjectId(id)
          setWorkbench("objects")
        }
      }}
    >
      <div className={`agent-columns ${workbench ? "workbench-visible" : ""}`}>
        <Conversation
          name={name}
          agent={agent}
          memoryRequest={memoryRequest}
          onMemoryOpened={onMemoryOpened}
          workbenchAction={
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={objectEditing || routinePending}
                render={
                  <Button
                    size="sm"
                    variant={workbench ? "secondary" : "ghost"}
                    disabled={objectEditing || routinePending}
                    aria-label="Open workbench"
                  />
                }
              >
                <PanelRight data-icon="inline-start" />
                <span className="chat-action-label hidden sm:inline">
                  Workbench
                </span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    disabled={navigationLocked}
                    onClick={() => setWorkbench("activity")}
                  >
                    <Activity /> Activity
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setWorkbench("objects")}>
                    <ListTodo /> Objects
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={navigationLocked}
                    onClick={() => setWorkbench("browser")}
                  >
                    <Globe /> Browser
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={navigationLocked}
                    onClick={() => setWorkbench("code")}
                  >
                    <Code2 /> Code
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={navigationLocked}
                    onClick={() => setWorkbench("apps")}
                  >
                    <PanelsTopLeft /> Apps
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={navigationLocked}
                    onClick={() => setWorkbench("routines")}
                  >
                    <Clock3 /> Routines
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={navigationLocked}
                    onClick={() => setWorkbench("terminal")}
                  >
                    <TerminalSquare /> Terminal
                  </DropdownMenuItem>
                  {workbench && (
                    <DropdownMenuItem
                      disabled={navigationLocked}
                      onClick={() => setWorkbench(null)}
                    >
                      Hide workbench
                    </DropdownMenuItem>
                  )}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />
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
            onClose={() => setWorkbench(null)}
          />
        )}
        {workbench === "terminal" && (
          <TerminalWorkbench
            agentId={agent.id}
            agentName={agent.name}
            onClose={() => setWorkbench(null)}
          />
        )}
        {workbench === "routines" && (
          <RoutinesWorkbench
            onPendingChange={setRoutinePending}
            agentId={agent.id}
            agentName={agent.name}
            onClose={() => setWorkbench(null)}
          />
        )}
        {workbench === "objects" && (
          <ObjectsWorkbench
            selected={objectId}
            onSelect={setObjectId}
            agentName={agent.name}
            onClose={() => setWorkbench(null)}
            onEditing={setObjectEditing}
          />
        )}
        {workbench === "apps" && (
          <AppsWorkbench
            agentId={agent.id}
            agentName={agent.name}
            onClose={() => setWorkbench(null)}
          />
        )}
        {workbench === "code" && (
          <ExecutionWorkbench
            agentId={agent.id}
            agentName={agent.name}
            onClose={() => setWorkbench(null)}
          />
        )}
        {browserOpen && (
          <BrowserWorkbench
            agentId={agent.id}
            agentName={agent.name}
            onClose={() => setWorkbench(null)}
          />
        )}
      </div>
    </ObjectsProvider>
  )
}
