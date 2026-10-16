import { useBlocker } from "@tanstack/react-router"
import { PanelRight } from "lucide-react"
import { lazy, Suspense, useCallback, useEffect, useState, useRef } from "react"

import { homeAgentId } from "@/agents/contracts"
import type { AgentProfile } from "@/agents/contracts"
import { authClient } from "@/auth/client"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { RuntimeStatus } from "@/conversations/status"
import {
  AgentEditor,
  AgentSidebar,
  ArchiveAgentDialog,
  useAgentCatalog,
} from "@/features/agents"
import { AgentCollection } from "@/features/agents/agent-collection"
import { useAgentStatuses } from "@/features/agents/use-agent-statuses"
import { Conversation, useConversation } from "@/features/conversation"
import { useFiles } from "@/features/files/use-files"
import { ObjectsProvider } from "@/features/objects/context"
import { markReady } from "@/features/performance"
import { api } from "@/http/client"

import { MobileNavigation } from "./mobile-navigation"
import { useWorkspaceLocation } from "./use-workspace-location"
import { WorkbenchPanel } from "./workbench"
import {
  WorkspaceNavigation,
  type Workbench,
  type WorkspaceAction,
} from "./workspace-navigation"
import type { SettingsCategory } from "./workspace-settings"
import { WorkspaceStartup } from "./workspace-startup"

const Login = lazy(() =>
  import("@/features/auth/login").then((m) => ({ default: m.Login }))
)

const FilesWorkbench = lazy(() =>
  import("@/features/files/files-panel").then((m) => ({
    default: m.FilesWorkbench,
  }))
)
const WorkspaceSettings = lazy(() =>
  import("./workspace-settings").then((m) => ({ default: m.WorkspaceSettings }))
)
const MemoryWorkbench = lazy(() =>
  import("@/features/memory").then((m) => ({ default: m.MemoryWorkbench }))
)
const RoutinesWorkbench = lazy(() =>
  import("@/features/routines").then((m) => ({ default: m.RoutinesWorkbench }))
)
const ActivityWorkbench = lazy(() =>
  import("@/features/activity").then((m) => ({ default: m.ActivityWorkbench }))
)
const TerminalWorkbench = lazy(() =>
  import("@/features/terminal").then((m) => ({ default: m.TerminalWorkbench }))
)
const AppsWorkbench = lazy(() =>
  import("@/features/apps/apps-workbench").then((m) => ({
    default: m.AppsWorkbench,
  }))
)
const ExecutionWorkbench = lazy(() =>
  import("@/features/execution").then((m) => ({
    default: m.ExecutionWorkbench,
  }))
)
const BrowserWorkbench = lazy(() =>
  import("@/features/browser").then((m) => ({ default: m.BrowserWorkbench }))
)

const ObjectsWorkbench = lazy(() =>
  import("@/features/objects/workbench").then((m) => ({
    default: m.ObjectsWorkbench,
  }))
)

export function ChatApp() {
  const { data: session, isPending, error } = authClient.useSession()
  useEffect(() => {
    if (session && !isPending) markReady("session")
  }, [session, isPending])
  if (isPending) return <WorkspaceStartup />
  if (!session)
    return (
      <Suspense fallback={<WorkspaceStartup />}>
        <Login sessionError={error?.message} />
      </Suspense>
    )
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
  const {
    collection,
    securityOpen,
    settings,
    workbench,
    editor,
    conversationId,
    conversationEnabled,
  } = workspaceRoute(location, catalog.selected)
  const conversation = useConversation(conversationId, conversationEnabled)
  const runtime = useAgentStatuses(catalog.agents, ownerId, location.agentId)
  const [startupComplete, setStartupComplete] = useState(false)
  const setSecurityOpen = location.setSecurity
  const [workLocked, setNavigationLocked] = useState(false)
  const [settingsPending, setSettingsPending] = useState(false)
  const setSettings = location.setSettings
  const navigationLocked = workLocked || settingsPending
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
  // The hooks above keep catalog and conversation requests parallel while the
  // initial view stays stable. Errors release it; later reconnects and agent
  // navigation keep their existing in-workspace loading/recovery controls.
  const starting = workspaceStarting(
    catalog,
    conversation,
    collection,
    editor !== null
  )
  if (!startupComplete && starting) return <WorkspaceStartup />
  if (!startupComplete) setStartupComplete(true)
  return (
    <TooltipProvider>
      <SidebarProvider
        className="workspace-shell"
        style={
          {
            "--sidebar-width": "var(--workspace-sidebar-width)",
          } as React.CSSProperties
        }
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
            statuses={runtime.statuses}
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
          <main id="main-content" tabIndex={-1} className="workspace-main">
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
            {collection ? (
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
                conversation={conversation}
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
                onStatus={runtime.setLive}
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
                <p className="text-sm text-muted-foreground">
                  Your workspace is unavailable.
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
  conversation,
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
  onStatus,
}: {
  location: ReturnType<typeof useWorkspaceLocation>
  conversation: ReturnType<typeof useConversation>
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
  onStatus: (value: { agentId: string; status: RuntimeStatus }) => void
}) {
  const { setOpenMobile } = useSidebar()
  const { state: runState, turnId: runTurnId } =
    conversationRuntime(conversation)
  useEffect(() => {
    onStatus({
      agentId: agent.id,
      status: { state: runState, turnId: runTurnId },
    })
  }, [agent.id, runState, runTurnId, onStatus])
  const files = useFiles(agent.id)
  const [workbenchView, setWorkbenchView] = useState({
    panel: workbench,
    search: location.search,
  })
  if (
    workbench &&
    (workbench !== workbenchView.panel ||
      location.search !== workbenchView.search)
  ) {
    setWorkbenchView({ panel: workbench, search: location.search })
  }
  const renderedWorkbench = workbench ?? workbenchView.panel
  const renderedSearch = workbench ? location.search : workbenchView.search
  const workbenchTrigger = useRef<HTMLButtonElement>(null)
  const [sending, setSending] = useState(false)
  const [filePending, setFilePending] = useState(false)
  const [workbenchAppPending, setAppPending] = useState(false)
  const [inlineAppRequests, setInlineAppRequests] = useState<
    ReadonlySet<string>
  >(new Set())
  const onAppPendingChange = useCallback((key: string, pending: boolean) => {
    setInlineAppRequests((current) => {
      if (current.has(key) === pending) return current
      const next = new Set(current)
      if (pending) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])
  const appPending = workbenchAppPending || inlineAppRequests.size > 0
  const [executionPending, setExecutionPending] = useState(false)
  const [objectPending, setObjectPending] = useState(false)
  const [objectEditing, setObjectEditing] = useState(false)
  const [routinePending, setRoutinePending] = useState(false)
  useEffect(() => {
    onNavigationLockChange(
      objectPending ||
        objectEditing ||
        routinePending ||
        appPending ||
        executionPending ||
        filePending
    )
  }, [
    filePending,
    objectPending,
    objectEditing,
    routinePending,
    appPending,
    executionPending,
    onNavigationLockChange,
  ])
  const editingLocked =
    objectEditing ||
    routinePending ||
    appPending ||
    executionPending ||
    filePending
  const locked = objectPending || editingLocked
  const recoverChecklist =
    objectPending && !editingLocked && workbench !== "objects"
  function openWorkbench(value: Workbench | null) {
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
    <WorkspaceSettingsOverlay
      settings={settings}
      securityOpen={securityOpen}
      location={location}
      consumeConnectionCallback={consumeConnectionCallback}
      setSettings={setSettings}
      agent={agent}
      conversation={conversation}
      onSettingsPending={onSettingsPending}
      onSecurityOpenChange={onSecurityOpenChange}
      openWorkbench={openWorkbench}
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
          onAppPendingChange={onAppPendingChange}
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
            <WorkbenchToggle
              workbench={workbench}
              recoverChecklist={recoverChecklist}
              objectPending={objectPending}
              editingLocked={editingLocked}
              workbenchTrigger={workbenchTrigger}
              openWorkbench={openWorkbench}
            />
          }
        />
        {renderedWorkbench && (
          <WorkbenchPanel
            open={workbench !== null}
            value={renderedWorkbench}
            onChange={openWorkbench}
            onClosed={() => {
              if (workbench === null)
                setWorkbenchView({ panel: null, search: location.search })
            }}
            returnFocus={workbenchTrigger}
            agentName={agent.name}
            locked={locked}
            overlayOpen={overlayOpen || settings !== null}
            overlays={settingsPanel}
            recoveryAction={
              recoverChecklist ? (
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
            <Suspense fallback={<p role="status">Opening workspace tool…</p>}>
              <WorkspaceTool
                renderedWorkbench={renderedWorkbench}
                renderedSearch={renderedSearch}
                location={location}
                agent={agent}
                agents={agents}
                onOpenBot={onOpenBot}
                onMemory={onMemory}
                setExecutionPending={setExecutionPending}
                setRoutinePending={setRoutinePending}
                setObjectEditing={setObjectEditing}
                setAppPending={setAppPending}
                setFilePending={setFilePending}
                files={files}
                sending={sending}
                openWorkbench={openWorkbench}
                conversation={conversation}
              />
            </Suspense>
          </WorkbenchPanel>
        )}
      </div>
      {!renderedWorkbench && settingsPanel}
      {mobileNavigation(false)}
    </ObjectsProvider>
  )
}

function workspaceRoute(
  location: ReturnType<typeof useWorkspaceLocation>,
  selected: AgentProfile | null | undefined
) {
  const collection = ["/agents", "/agents/archived"].includes(location.pathname)
  const editor =
    location.pathname === "/agents/new"
      ? { key: "new", agent: undefined }
      : location.pathname.endsWith("/edit") && selected
        ? { key: selected.id, agent: selected }
        : null
  return {
    collection,
    editor,
    securityOpen: location.search.security ?? false,
    settings:
      location.search.settings ??
      (location.search.connections ? ("connections" as const) : null),
    workbench: location.search.panel ?? null,
    conversationId: location.agentId ?? selected?.id ?? homeAgentId,
    conversationEnabled: !collection && (!!location.agentId || !!selected),
  }
}
function workspaceStarting(
  catalog: ReturnType<typeof useAgentCatalog>,
  conversation: ReturnType<typeof useConversation>,
  collection: boolean,
  editing: boolean
) {
  const starting =
    !catalog.error &&
    (catalog.loading ||
      (!collection &&
        !editing &&
        !!catalog.selected &&
        !conversation.state &&
        !conversation.error))
  return starting
}

function conversationRuntime(
  conversation: ReturnType<typeof useConversation>
): RuntimeStatus {
  return {
    state: conversation.error
      ? "unavailable"
      : (conversation.state?.runtime?.state ?? "unavailable"),
    turnId: conversation.state?.runtime?.turnId ?? null,
  }
}

function WorkspaceTool({
  renderedWorkbench,
  renderedSearch,
  location,
  agent,
  agents,
  onOpenBot,
  onMemory,
  setExecutionPending,
  setRoutinePending,
  setObjectEditing,
  setAppPending,
  setFilePending,
  files,
  sending,
  openWorkbench,
  conversation,
}: {
  renderedWorkbench: Workbench
  renderedSearch: ReturnType<typeof useWorkspaceLocation>["search"]
  location: ReturnType<typeof useWorkspaceLocation>
  agent: AgentProfile
  agents: readonly AgentProfile[]
  onOpenBot: (id: AgentProfile["id"]) => void
  onMemory: (id: AgentProfile["id"]) => void
  setExecutionPending: (pending: boolean) => void
  setRoutinePending: (pending: boolean) => void
  setObjectEditing: (pending: boolean) => void
  setAppPending: (pending: boolean) => void
  setFilePending: (pending: boolean) => void
  files: ReturnType<typeof useFiles>
  sending: boolean
  openWorkbench: (value: Workbench | null) => void
  conversation: ReturnType<typeof useConversation>
}) {
  const selected = renderedSearch.item ?? null
  const terminalTab = terminalWorkspaceTab(renderedSearch.tab)
  const memoryTab = memoryWorkspaceTab(renderedSearch.tab)
  switch (renderedWorkbench) {
    case "activity":
      return (
        <ActivityWorkbench
          filters={{
            scope: renderedSearch.scope,
            filter: renderedSearch.filter,
            cursor: renderedSearch.cursor,
          }}
          onFiltersChange={(value) => location.update(value)}
          offset={renderedSearch.offset ?? 0}
          onOffsetChange={(offset) =>
            location.update({ offset: offset || undefined })
          }
          view={renderedSearch.tab === "tasks" ? "tasks" : "timeline"}
          inspectedAgentId={renderedSearch.activityAgent ?? agent.id}
          selected={selected}
          onSelectionChange={(tab, activityAgent, item) =>
            location.update({
              tab,
              activityAgent,
              item: item ?? undefined,
              offset:
                tab !== (renderedSearch.tab ?? "timeline") ||
                activityAgent !== (renderedSearch.activityAgent ?? agent.id)
                  ? undefined
                  : renderedSearch.offset,
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
      )
    case "terminal":
      return (
        <TerminalWorkbench
          onPendingChange={setExecutionPending}
          agentId={agent.id}
          selected={selected}
          onSelect={location.setItem}
          tab={terminalTab}
          onTabChange={location.setTab}
        />
      )
    case "routines":
      return (
        <RoutinesWorkbench
          selected={selected}
          webhook={renderedSearch.tab === "webhook"}
          onSelect={(item, webhook) =>
            location.update({
              item: item ?? undefined,
              tab: webhook ? "webhook" : undefined,
            })
          }
          onPendingChange={setRoutinePending}
          agentId={agent.id}
        />
      )
    case "objects":
      return (
        <ObjectsWorkbench
          selected={selected}
          onSelect={location.setItem}
          onEditing={setObjectEditing}
        />
      )
    case "apps":
      return (
        <AppsWorkbench
          selected={selected}
          onSelect={location.setItem}
          onPendingChange={setAppPending}
          agentId={agent.id}
        />
      )
    case "code":
      return (
        <ExecutionWorkbench
          onPendingChange={setExecutionPending}
          agentId={agent.id}
          selected={selected}
          onSelect={location.setItem}
        />
      )
    case "browser":
      return (
        <BrowserWorkbench
          agentId={agent.id}
          agentName={agent.name}
          onPendingChange={setExecutionPending}
        />
      )
    case "files":
      return (
        <FilesWorkbench
          previewView={renderedSearch.preview ?? "preview"}
          onPreviewViewChange={(preview) => location.update({ preview })}
          onPendingChange={setFilePending}
          selected={selected}
          onSelect={location.setItem}
          collection={renderedSearch.tab === "trash" ? "trash" : "files"}
          onCollectionChange={location.setTab}
          state={files}
          selectionDisabled={sending || files.uploading}
          onAttached={() => openWorkbench(null)}
        />
      )
    case "memory":
      return (
        <MemoryWorkbench
          query={renderedSearch.query ?? ""}
          onQueryChange={(query) =>
            location.update({ query: query || undefined }, true)
          }
          state={conversation.state}
          agentId={agent.id}
          tab={memoryTab}
          onTabChange={location.setTab}
        />
      )
  }
}

function WorkbenchToggle({
  workbench,
  recoverChecklist,
  objectPending,
  editingLocked,
  workbenchTrigger,
  openWorkbench,
}: {
  workbench: Workbench | null
  recoverChecklist: boolean
  objectPending: boolean
  editingLocked: boolean
  workbenchTrigger: React.Ref<HTMLButtonElement>
  openWorkbench: (value: Workbench | null) => void
}) {
  return (
    (!workbench || recoverChecklist) && (
      <Button
        ref={workbenchTrigger}
        size="icon-sm"
        variant="ghost"
        disabled={editingLocked}
        aria-label={objectPending ? "Recover checklist save" : "Open workbench"}
        onClick={() => openWorkbench(objectPending ? "objects" : "files")}
      >
        <PanelRight />
      </Button>
    )
  )
}

function terminalWorkspaceTab(
  tab: ReturnType<typeof useWorkspaceLocation>["search"]["tab"]
) {
  return tab === "interactive" || tab === "transfers" ? tab : "commands"
}
function memoryWorkspaceTab(
  tab: ReturnType<typeof useWorkspaceLocation>["search"]["tab"]
) {
  return tab === "history" || tab === "tree" || tab === "files" ? tab : "notes"
}

function WorkspaceSettingsOverlay({
  settings,
  securityOpen,
  location,
  consumeConnectionCallback,
  setSettings,
  agent,
  conversation,
  onSettingsPending,
  onSecurityOpenChange,
  openWorkbench,
}: Pick<
  Parameters<typeof AgentWorkspace>[0],
  | "settings"
  | "securityOpen"
  | "location"
  | "setSettings"
  | "agent"
  | "conversation"
  | "onSettingsPending"
  | "onSecurityOpenChange"
> & {
  consumeConnectionCallback: () => void
  openWorkbench: (value: Workbench | null) => void
}) {
  return settings || securityOpen ? (
    <Suspense fallback={<p role="status">Opening settings…</p>}>
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
    </Suspense>
  ) : null
}
