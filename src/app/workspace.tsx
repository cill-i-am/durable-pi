import { AgentCollection } from "@/features/agents/agent-collection"
import { useWorkspaceLocation } from "./use-workspace-location"
import { useBlocker } from "@tanstack/react-router"
import { homeAgentId } from "@/agents/contracts"
import { WorkspaceSettings, type SettingsCategory } from "./workspace-settings"
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
import { useCallback, useEffect, useState, useRef } from "react"
import { ObjectsProvider, ObjectsWorkbench } from "@/features/objects"
import { PanelRight } from "lucide-react"
import { TerminalWorkbench } from "@/features/terminal"
import { AppsWorkbench } from "@/features/apps"
import { ExecutionWorkbench } from "@/features/execution"
import { BrowserWorkbench } from "@/features/browser"
import { authClient } from "@/auth/client"
import { Login, PiMark } from "@/features/auth"
import { Conversation, useConversation } from "@/features/conversation"
import {
  AgentEditor,
  AgentSidebar,
  ArchiveAgentDialog,
  useAgentCatalog,
} from "@/features/agents"
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
  const location = useWorkspaceLocation()
  const catalog = useAgentCatalog(ownerId, location.agentId)
  const securityOpen = location.search.security ?? false
  const setSecurityOpen = location.setSecurity
  const [workLocked, setNavigationLocked] = useState(false)
  const [settingsPending, setSettingsPending] = useState(false)
  const settings =
    location.search.settings ??
    (location.search.connections ? "connections" : null)
  const setSettings = location.setSettings
  const navigationLocked = workLocked || settingsPending
  const workbench = location.search.panel ?? null
  const setWorkbench = location.setPanel
  useEffect(() => {
    if (location.pathname === "/" && !catalog.loading && catalog.selected) {
      location.openAgent(
        catalog.selected.id,
        {
          ...(location.search.connections
            ? {
                settings: "connections",
                connections: location.search.connections,
              }
            : {}),
          panel:
            location.search.panel ??
            (window.matchMedia("(min-width: 1024px)").matches
              ? "apps"
              : undefined),
        },
        true
      )
    }
  }, [
    location.pathname,
    location.openAgent,
    location.search,
    catalog.loading,
    catalog.selected,
  ])
  function selectAgent(id: AgentProfile["id"], panel?: Workbench) {
    if (navigationLocked) return
    catalog.select(id)
    if (id !== location.agentId || panel) location.openAgent(id, { panel })
  }
  const editor =
    location.pathname === "/agents/new"
      ? { key: "new", agent: undefined }
      : location.pathname.endsWith("/edit") && catalog.selected
        ? { key: catalog.selected.id, agent: catalog.selected }
        : null
  const savedEditor = useRef<AgentProfile["id"] | null>(null)
  function setEditor(value: { agent?: AgentProfile; key: string } | null) {
    savedEditor.current = null
    if (value) location.openEditor(value.agent?.id)
    else location.closeEditor()
  }
  const [error, setError] = useState("")
  const [archiveTarget, setArchiveTarget] = useState<AgentProfile | null>(null)
  const [navigationBlocked, setNavigationBlocked] = useState(false)
  useBlocker({
    shouldBlockFn: () => {
      const blocked =
        navigationLocked || editor !== null || archiveTarget !== null
      if (blocked) setNavigationBlocked(true)
      return blocked
    },
    enableBeforeUnload: navigationLocked || editor !== null,
  })
  useEffect(() => {
    if (!navigationLocked && !editor && !archiveTarget)
      setNavigationBlocked(false)
  }, [navigationLocked, editor, archiveTarget])
  async function updateArchive(agent: AgentProfile, archived: boolean) {
    await api("/api/agent/bots/archive", { id: agent.id, archived })
    setError("")
    // A failed list refresh must not present a confirmed mutation as a failed save.
    await catalog.refresh().catch(() => {
      setError(
        "Agent updated, but the list could not refresh. Try refreshing it."
      )
    })
  }
  async function archive(agent: AgentProfile) {
    if (navigationLocked) return
    if (agent.status === "active") {
      setArchiveTarget(agent)
      return
    }
    try {
      await updateArchive(agent, false)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not restore this agent.")
    }
  }
  function act(action: WorkspaceAction) {
    if (navigationLocked) return
    if (action === "create") setEditor({ key: crypto.randomUUID() })
    else if (action === "edit" && catalog.selected)
      setEditor({ key: catalog.selected.id, agent: catalog.selected })
    else if (action === "archive" && catalog.selected)
      void archive(catalog.selected)
    else if (action === "settings") setSettings("general")
    else if (action === "security") {
      setSecurityOpen(true)
    } else if (action === "sign-out") void authClient.signOut()
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
            view={location.search}
            query={location.search.q ?? ""}
            onQuery={location.setQuery}
            archived={
              location.pathname === "/agents/archived" ||
              catalog.selected?.status === "archived"
            }
            disabled={navigationLocked}
            agents={catalog.agents}
            selected={catalog.selected}
            name={name}
            onSettings={() => act("settings")}
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
            {navigationBlocked && (
              <Alert>
                <AlertDescription>
                  Finish or cancel the open edit before leaving this view.
                </AlertDescription>
              </Alert>
            )}
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
            {location.pathname === "/agents" ||
            location.pathname === "/agents/archived" ? (
              <AgentCollection
                agents={catalog.agents}
                archived={location.pathname === "/agents/archived"}
                query={location.search.q ?? ""}
                onQuery={location.setQuery}
                onCreate={() => act("create")}
                onRestore={(agent) => void archive(agent)}
              />
            ) : catalog.selected ? (
              <AgentWorkspace
                key={catalog.selected.id}
                location={location}
                overlayOpen={archiveTarget !== null || editor !== null}
                settings={settings}
                setSettings={setSettings}
                onSettingsPending={setSettingsPending}
                securityOpen={securityOpen}
                onSecurityOpenChange={setSecurityOpen}
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
                    selectAgent(id, "memory")
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
                {!catalog.loading && (
                  <Button
                    variant="outline"
                    onClick={() => selectAgent(homeAgentId)}
                  >
                    Open home agent
                  </Button>
                )}
              </div>
            )}
          </main>
        </div>
        {archiveTarget && (
          <ArchiveAgentDialog
            key={archiveTarget.id}
            agent={archiveTarget}
            onConfirm={() => updateArchive(archiveTarget, true)}
            onClose={() => setArchiveTarget(null)}
          />
        )}
        {editor && (
          <AgentEditor
            key={editor.key}
            open
            agent={editor.agent}
            onOpenChange={(open) => {
              if (!open) {
                if (savedEditor.current && !editor.agent)
                  location.openAgent(savedEditor.current)
                else location.closeEditor()
                savedEditor.current = null
              }
            }}
            onSaved={async (agent) => {
              await catalog.refresh()
              savedEditor.current = agent.id
            }}
          />
        )}
      </SidebarProvider>
    </TooltipProvider>
  )
}

function AgentWorkspace({
  location,
  overlayOpen,
  settings,
  setSettings,
  onSettingsPending,
  securityOpen,
  onSecurityOpenChange,
  workbench,
  setWorkbench,
  agent,
  agents,
  onOpenBot,
  onMemory,
  name,
  onNavigationLockChange,
}: {
  location: ReturnType<typeof useWorkspaceLocation>
  overlayOpen: boolean
  settings: SettingsCategory | null
  setSettings: (value: SettingsCategory | null) => void
  onSettingsPending: (pending: boolean) => void
  securityOpen: boolean
  onSecurityOpenChange: (open: boolean) => void
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
  const [filePending, setFilePending] = useState(false)
  const [appPending, setAppPending] = useState(false)
  const objectId = location.search.item ?? null
  const setObjectId = location.setItem
  const [objectPending, setObjectPending] = useState(false)
  const [objectEditing, setObjectEditing] = useState(false)
  const [routinePending, setRoutinePending] = useState(false)
  useEffect(() => {
    onNavigationLockChange(
      objectPending ||
        objectEditing ||
        routinePending ||
        appPending ||
        filePending
    )
  }, [
    filePending,
    objectPending,
    objectEditing,
    routinePending,
    appPending,
    onNavigationLockChange,
  ])
  const locked =
    objectPending ||
    objectEditing ||
    routinePending ||
    appPending ||
    filePending
  const editingLocked =
    objectEditing || routinePending || appPending || filePending
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
      onChat={() => {
        if (locked) return
        setOpenMobile(false)
        openWorkbench(null)
      }}
      onWorkspace={() =>
        openWorkbench(objectPending ? "objects" : (workbench ?? "files"))
      }
    />
  )
  const consumeConnectionCallback = useCallback(
    () =>
      location.update(
        { connections: undefined, settings: "connections" },
        true
      ),
    [location.update]
  )
  const settingsPanel = (
    <WorkspaceSettings
      category={settings}
      connectionResult={location.search.connections}
      onConnectionResultConsumed={consumeConnectionCallback}
      onCategoryChange={setSettings}
      agent={agent}
      conversation={conversation}
      onPendingChange={onSettingsPending}
      securityOpen={securityOpen}
      onSecurityOpenChange={onSecurityOpenChange}
      onWorkbench={openWorkbench}
    />
  )
  return (
    <ObjectsProvider
      agentId={agent.id}
      archived={agent.status === "archived"}
      onPendingChange={setObjectPending}
      onOpen={(id) => {
        if (!objectEditing && !routinePending && !appPending && !filePending) {
          location.update({ panel: "objects", item: id, tab: undefined })
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
          onSettings={(category) => {
            if (!locked) setSettings(category)
          }}
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
            overlayOpen={overlayOpen || settings !== null}
            overlays={settingsPanel}
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
                filters={{
                  scope: location.search.scope,
                  filter: location.search.filter,
                  cursor: location.search.cursor,
                }}
                onFiltersChange={(value) => location.update(value)}
                offset={location.search.offset ?? 0}
                onOffsetChange={(offset) =>
                  location.update({ offset: offset || undefined })
                }
                view={location.search.tab === "tasks" ? "tasks" : "timeline"}
                inspectedAgentId={location.search.activityAgent ?? agent.id}
                selected={location.search.item ?? null}
                onSelectionChange={(tab, activityAgent, item) =>
                  location.update({
                    tab,
                    activityAgent,
                    item: item ?? undefined,
                    offset:
                      tab !== (location.search.tab ?? "timeline") ||
                      activityAgent !==
                        (location.search.activityAgent ?? agent.id)
                        ? undefined
                        : location.search.offset,
                  })
                }
                agents={agents}
                onOpenBot={(id) => {
                  onOpenBot(id)
                }}
                onMemory={(id) => {
                  onMemory(id)
                }}
                agentId={agent.id}
                agentName={agent.name}
              />
            )}
            {workbench === "terminal" && (
              <TerminalWorkbench
                agentId={agent.id}
                agentName={agent.name}
                selected={location.search.item ?? null}
                onSelect={location.setItem}
                tab={
                  location.search.tab === "interactive" ||
                  location.search.tab === "transfers"
                    ? location.search.tab
                    : "commands"
                }
                onTabChange={location.setTab}
              />
            )}
            {workbench === "routines" && (
              <RoutinesWorkbench
                selected={location.search.item ?? null}
                webhook={location.search.tab === "webhook"}
                onSelect={(item, webhook) =>
                  location.update({
                    item: item ?? undefined,
                    tab: webhook ? "webhook" : undefined,
                  })
                }
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
                selected={location.search.item ?? null}
                onSelect={location.setItem}
                onOpenWorkbench={openWorkbench}
                onPendingChange={setAppPending}
                agentId={agent.id}
                agentName={agent.name}
              />
            )}
            {workbench === "code" && (
              <ExecutionWorkbench
                agentId={agent.id}
                agentName={agent.name}
                selected={location.search.item ?? null}
                onSelect={location.setItem}
              />
            )}
            {workbench === "browser" && (
              <BrowserWorkbench agentId={agent.id} agentName={agent.name} />
            )}
            {workbench === "files" && (
              <FilesWorkbench
                previewView={location.search.preview ?? "preview"}
                onPreviewViewChange={(preview) => location.update({ preview })}
                onPendingChange={setFilePending}
                selected={location.search.item ?? null}
                onSelect={location.setItem}
                collection={location.search.tab === "trash" ? "trash" : "files"}
                onCollectionChange={location.setTab}
                state={files}
                selectionDisabled={sending || files.uploading}
                onAttached={() => openWorkbench(null)}
              />
            )}
            {workbench === "memory" && (
              <MemoryWorkbench
                query={location.search.query ?? ""}
                onQueryChange={(query) =>
                  location.update({ query: query || undefined }, true)
                }
                state={conversation.state}
                agentId={agent.id}
                tab={
                  location.search.tab === "history" ||
                  location.search.tab === "tree" ||
                  location.search.tab === "files"
                    ? location.search.tab
                    : "notes"
                }
                onTabChange={location.setTab}
              />
            )}
          </WorkbenchPanel>
        )}
      </div>
      {!workbench && settingsPanel}
      {mobileNavigation(false)}
    </ObjectsProvider>
  )
}
