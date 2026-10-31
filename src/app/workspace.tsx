import { useBlocker } from "@tanstack/react-router"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { PanelRight } from "lucide-react"
import { lazy, Suspense, useCallback, useEffect, useState, useRef } from "react"

import { homeAgentId } from "@/agents/contracts"
import type { AgentProfile } from "@/agents/contracts"
import { authClient } from "@/auth/client"
import { SidebarProvider } from "@/components/ui/sidebar"
import type { RuntimeStatus } from "@/conversations/status"
import {
  AgentEditor,
  ArchiveAgentDialog,
  useAgentCatalog,
} from "@/features/agents"
import { AgentCollection } from "@/features/agents/agent-collection"
import { useAgentArchive } from "@/features/agents/use-agent-archive"
import { useAgentStatuses } from "@/features/agents/use-agent-statuses"
import { Conversation, useConversation } from "@/features/conversation"
import { adoptDraftOwner } from "@/features/conversation/draft"
import { useComposerWorkspace } from "@/features/conversation/use-composer-draft"
import { FamilyWorkspace } from "@/features/family/context"
import type { FilesState } from "@/features/files/use-files"
import { ObjectsProvider } from "@/features/objects/context"
import { markReady } from "@/features/performance"
import {
  AssetBoundary,
  useReloadGuard,
} from "@/features/updates/update-recovery"
import { useIsMobile } from "@/hooks/use-mobile"
import {
  globalSettingsSection,
  isGlobalSettingsSection,
  workspaceContext,
} from "@/navigation/workspace"
import { listenForClientErrors } from "@/observability/browser"

import { useSettingsOwner } from "./use-settings-owner"
import { useWorkbenchPresence } from "./use-workbench-presence"
import { useWorkspaceGuard } from "./use-workspace-guard"
import {
  useWorkspaceLocation,
  useWorkspaceRoute,
} from "./use-workspace-location"
import { WorkbenchPanel } from "./workbench"
import {
  WorkspaceNavigation,
  type Workbench,
  type WorkspaceAction,
} from "./workspace-navigation"
import type { SettingsCategory } from "./workspace-settings"
import { WorkspaceStartup } from "./workspace-startup"

import "./workspace.css"

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
  useEffect(listenForClientErrors, [])
  const { data: session, isPending, error } = authClient.useSession()
  useEffect(() => {
    if (isPending || error) return
    try {
      adoptDraftOwner(sessionStorage, session?.user.id ?? null)
    } catch {
      /* Unavailable tab storage is handled by the draft guard. */
    }
  }, [session?.user.id, isPending, error])
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
    <FamilyWorkspace key={session.user.id}>
      <Workspace
        key={session.user.id}
        ownerId={session.user.id}
        name={session.user.name}
        image={session.user.image}
      />
    </FamilyWorkspace>
  )
}
/** Navigation and an update reload obey the same open-edit fence. */
function useWorkspaceProtection(
  locked: boolean,
  editing: boolean,
  archiving: boolean,
  starting: boolean
) {
  const protectedView = locked || editing || archiving
  const guard = useWorkspaceGuard({ protected: protectedView, starting })
  useReloadGuard(
    "Finish or cancel the open edit before reloading.",
    protectedView
  )
  useBlocker({
    shouldBlockFn: guard.block,
    enableBeforeUnload: protectedView,
  })
  return guard
}

function Workspace({
  ownerId,
  name,
  image,
}: {
  ownerId: string
  name: string
  image?: string | null
}) {
  const { params, query, pathname } = useWorkspaceRoute()
  const context = workspaceContext(pathname, params, query)
  const globalSection = context.globalSection
  const catalog = useAgentCatalog(ownerId, context.params.agentId)
  const location = useWorkspaceLocation(catalog.agents, catalog.selected)
  const {
    collection,
    archived,
    settings,
    workbench,
    editor,
    conversationId,
    conversationEnabled,
  } = workspaceRoute(location, catalog.selected)
  const conversation = useConversation(conversationId, conversationEnabled)
  const runtime = useAgentStatuses(catalog.agents, ownerId, location.agentId)
  const setSecurityOpen = location.setSecurity
  const [workLocked, setNavigationLocked] = useState(false)
  const [settingsPending, setSettingsPending] = useState(false)
  const [settingsShown, setSettingsShown] = useState(false)
  const setSettings = location.setSettings
  const mobile = useIsMobile()
  const setWorkbench = location.setPanel
  const { openAgent, agentId, openArchivedAgents } = location
  useEffect(() => {
    if (agentId && archived) void openArchivedAgents(true)
  }, [agentId, archived, openArchivedAgents])
  useEffect(() => {
    if (location.pathname === "/" && !catalog.loading && catalog.selected) {
      void openAgent(
        catalog.selected.id,
        { panel: location.search.panel },
        true
      )
    }
  }, [
    location.pathname,
    openAgent,
    location.search,
    catalog.loading,
    catalog.selected,
  ])
  function selectAgent(id: AgentProfile["id"], panel?: Workbench) {
    if (navigationLocked || editor !== null || archiveTarget !== null) return
    catalog.select(id)
    void location.openAgent(id, { panel })
  }
  const savedEditor = useRef<AgentProfile["id"] | null>(null)
  function setEditor(value: { agent?: AgentProfile; key: string } | null) {
    savedEditor.current = null
    if (value) location.openEditor(value.agent?.id)
    else location.closeEditor()
  }
  const archiveOwner = useAgentArchive(async ({ agent, archived }, signal) => {
    if (archived && location.agentId === agent.id)
      await location.openAgent(homeAgentId, {}, true)
    signal.throwIfAborted()
    await catalog.refresh(signal)
  })
  const navigationLocked = workLocked || settingsPending || archiveOwner.locked
  const archiveTarget = archiveOwner.target
  const starting = workspaceStarting(
    catalog,
    conversation,
    collection,
    editor !== null,
    !!globalSection,
    !!context.backgroundPath
  )
  const protection = useWorkspaceProtection(
    navigationLocked,
    editor !== null,
    archiveTarget !== null,
    starting
  )
  function archive(agent: AgentProfile) {
    if (!navigationLocked) archiveOwner.request(agent)
  }
  function act(action: WorkspaceAction) {
    if (navigationLocked || editor !== null || archiveTarget !== null) return
    if (action === "create") setEditor({ key: crypto.randomUUID() })
    else if (action === "edit" && catalog.selected)
      setEditor({ key: catalog.selected.id, agent: catalog.selected })
    else if (action === "archive" && catalog.selected)
      void archive(catalog.selected)
    else if (action === "settings") setSettings(mobile ? "settings" : "account")
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
  const { view: agentView, retaining } = useSettingsOwner(
    settingsOwnerView(
      catalog.selected,
      { location, conversation, settings, workbench },
      {
        collection,
        globalSection,
        background: !!context.backgroundPath,
      }
    ),
    settingsShown
  )
  if (!protection.started && starting) return <WorkspaceStartup />
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
          image={image}
          agents={catalog.agents}
          collection={collection}
          statuses={runtime.statuses}
          selected={collection ? undefined : catalog.selected}
          locked={navigationLocked || editor !== null || archiveTarget !== null}
          onAction={act}
          onSelect={selectAgent}
          onCollection={location.openAgents}
          onAgentSettings={(agent) => {
            if (navigationLocked || editor !== null || archiveTarget !== null)
              return
            catalog.select(agent.id)
            void location.openAgent(agent.id, {
              settings: mobile ? "agent-settings" : "general",
            })
          }}
          onEdit={(agent) => {
            if (!navigationLocked) setEditor({ key: agent.id, agent })
          }}
          onArchive={archive}
        />
        <div className="workspace-body">
          <main id="main-content" tabIndex={-1} className="workspace-main">
            {protection.notice && (
              <Alert>
                <AlertDescription>
                  Finish or cancel the open edit before leaving this view.
                </AlertDescription>
              </Alert>
            )}
            {(archiveOwner.error || catalog.error) && (
              <Alert>
                <AlertDescription className="flex items-center justify-between">
                  {archiveOwner.error || catalog.error}
                  <Button
                    variant="ghost"
                    onClick={() => {
                      if (archiveOwner.unreconciled) archiveOwner.reconcile()
                      else void catalog.refresh().catch(() => {})
                    }}
                  >
                    Retry
                  </Button>
                </AlertDescription>
              </Alert>
            )}
            {collection ? (
              <AgentCollection
                agents={catalog.agents}
                archived={archived}
                query={location.search.q ?? ""}
                onQuery={location.setQuery}
                onCreate={() => act("create")}
                onArchive={(agent) => void archive(agent)}
                onEdit={(agent: AgentProfile) =>
                  setEditor({ key: agent.id, agent })
                }
              />
            ) : !agentView ? (
              <WorkspaceUnavailable
                globalSettings={!!globalSection}
                loading={catalog.loading}
                onOpen={() => selectAgent(homeAgentId)}
              />
            ) : null}
            <div className="contents" hidden={retaining}>
              {agentView && (
                <AgentWorkspace
                  key={agentView.agent.id}
                  ownerId={ownerId}
                  location={agentView.location}
                  conversation={agentView.conversation}
                  overlayOpen={archiveTarget !== null || editor !== null}
                  settings={retaining ? null : agentView.settings}
                  setSettings={setSettings}
                  onSettingsPending={setSettingsPending}
                  onSettingsShown={setSettingsShown}
                  settingsShown={settingsShown}
                  workbench={agentView.workbench}
                  setWorkbench={setWorkbench}
                  onNavigationLockChange={setNavigationLocked}
                  name={name}
                  image={image}
                  agent={agentView.agent}
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
              )}
            </div>
            <div id="settings-page-host" />
          </main>
        </div>
        <WorkspaceSettingsOverlay
          settings={settings}
          enabled={!agentView}
          agents={catalog.agents}
          location={location}
          setSettings={setSettings}
          conversation={conversation}
          onSettingsPending={setSettingsPending}
          openWorkbench={setWorkbench}
        />
        {archiveTarget && (
          <ArchiveAgentDialog
            key={archiveTarget.id}
            agent={archiveTarget}
            onConfirm={archiveOwner.confirm}
            pending={archiveOwner.pending}
            error={archiveOwner.error}
            onClose={archiveOwner.dismiss}
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
                  void location.openAgent(savedEditor.current)
                else location.closeEditor()
                savedEditor.current = null
              }
            }}
            onSaved={async (agent, signal) => {
              savedEditor.current = agent.id
              await catalog.refresh(signal)
            }}
          />
        )}
      </SidebarProvider>
    </TooltipProvider>
  )
}

function settingsOwnerView(
  agent: AgentProfile | null | undefined,
  view: Omit<NonNullable<Parameters<typeof useSettingsOwner>[0]>, "agent">,
  options: { collection: boolean; globalSection?: string; background: boolean }
) {
  return !options.collection &&
    canRenderAgent(agent, options.globalSection, options.background)
    ? { ...view, agent }
    : null
}

function WorkspaceUnavailable({
  globalSettings,
  loading,
  onOpen,
}: {
  globalSettings: boolean
  loading: boolean
  onOpen: () => void
}) {
  if (globalSettings) return null
  return (
    <div className="loading-view">
      <p className="text-sm text-muted-foreground">
        This assistant is unavailable.
      </p>
      {!loading && (
        <Button variant="outline" onClick={onOpen}>
          Open personal assistant
        </Button>
      )}
    </div>
  )
}

function AgentWorkspace({
  ownerId,
  location,
  conversation,
  overlayOpen,
  settings,
  setSettings,
  onSettingsPending,
  onSettingsShown,
  settingsShown,
  workbench,
  setWorkbench,
  agent,
  agents,
  onOpenBot,
  onMemory,
  name,
  image,
  onNavigationLockChange,
  onStatus,
}: {
  ownerId: string
  location: ReturnType<typeof useWorkspaceLocation>
  conversation: ReturnType<typeof useConversation>
  overlayOpen: boolean
  settings: SettingsCategory | null
  setSettings: (value: SettingsCategory | null) => void
  onSettingsPending: (pending: boolean) => void
  onSettingsShown: (shown: boolean) => void
  settingsShown: boolean
  workbench: Workbench | null
  setWorkbench: (value: Workbench | null) => void
  agent: AgentProfile
  agents: readonly AgentProfile[]
  onOpenBot: (id: AgentProfile["id"]) => void
  onMemory: (id: AgentProfile["id"]) => void
  name: string
  image?: string | null
  onNavigationLockChange: (value: boolean) => void
  onStatus: (value: { agentId: string; status: RuntimeStatus }) => void
}) {
  const { state: runState, turnId: runTurnId } =
    conversationRuntime(conversation)
  useEffect(() => {
    onStatus({
      agentId: agent.id,
      status: { state: runState, turnId: runTurnId },
    })
  }, [agent.id, runState, runTurnId, onStatus])
  const [sending, setSending] = useState(false)
  const { composerDraft, files } = useComposerWorkspace(
    ownerId,
    agent.id,
    sending
  )
  const presence = useWorkbenchPresence({
    panel: workbench,
    search: location.search,
    held: settingsShown,
  })
  const renderedWorkbench = presence.panel ?? presence.retainedPanel
  const searchByTool = useRef<
    Partial<Record<Workbench, typeof location.search>>
  >({})
  useEffect(() => {
    if (workbench) searchByTool.current[workbench] = toolQuery(location.search)
  }, [workbench, location.search])
  const [workbenchExpanded, setWorkbenchExpanded] = useState(false)
  const workbenchOpen = workbench !== null || presence.held
  const workbenchTrigger = useRef<HTMLButtonElement>(null)
  const [toolRequests, setToolRequests] = useState<
    Partial<Record<Workbench, boolean>>
  >({})
  const onToolPending = useCallback((panel: Workbench, pending: boolean) => {
    setToolRequests((current) =>
      current[panel] === pending ? current : { ...current, [panel]: pending }
    )
  }, [])
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
  const [objectPending, setObjectPending] = useState(false)
  const [objectEditing, setObjectEditing] = useState(false)
  // Each retained tool reports its own owner state. A settled background tool
  // must never release another tool's in-flight navigation fence.
  const editingLocked =
    objectEditing ||
    Object.values(toolRequests).some(Boolean) ||
    inlineAppRequests.size > 0
  const locked = objectPending || editingLocked
  useEffect(() => {
    onNavigationLockChange(locked)
  }, [locked, onNavigationLockChange])
  const recoverChecklist =
    objectPending && !editingLocked && workbench !== "objects"
  function openWorkbench(value: Workbench | null) {
    if (locked && !(value === "objects" && !editingLocked)) return
    if (value === null) setWorkbench(null)
    else
      location.update({
        ...emptyToolQuery,
        ...searchByTool.current[value],
        panel: value,
        settings: undefined,
        security: undefined,
        connections: undefined,
        returnTo: undefined,
      })
  }
  const settingsPanel = (
    <WorkspaceSettingsOverlay
      settings={settings}
      location={location}
      setSettings={setSettings}
      agent={agent}
      agents={agents}
      conversation={conversation}
      onSettingsPending={onSettingsPending}
      onSettingsShown={onSettingsShown}
      openWorkbench={openWorkbench}
    />
  )

  return (
    <ObjectsProvider
      agentId={agent.id}
      archived={agent.status === "archived"}
      onPendingChange={setObjectPending}
      onOpen={(id) => {
        if (!editingLocked) {
          location.update({ panel: "objects", item: id, tab: undefined })
        }
      }}
    >
      <div
        className="agent-columns"
        data-workbench-open={workbench !== null}
        data-workbench-expanded={workbench !== null && workbenchExpanded}
      >
        <Conversation
          composerDraft={composerDraft}
          onAppPendingChange={onAppPendingChange}
          name={name}
          userImage={image}
          agent={agent}
          files={files}
          conversation={conversation}
          sending={sending}
          setSending={setSending}
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
            open={workbenchOpen}
            value={renderedWorkbench}
            onChange={openWorkbench}
            onClosed={presence.closed}
            returnFocus={workbenchTrigger}
            agentName={agent.name}
            agentReference={agent.slug}
            locked={locked}
            overlayOpen={overlayOpen || settings !== null || settingsShown}
            overlays={presence.panel ? settingsPanel : undefined}
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
            mobileNavigation={null}
            onExpandedChange={setWorkbenchExpanded}
            renderTool={(panel, active) => (
              <AssetBoundary>
                <Suspense
                  fallback={<p role="status">Opening workspace tool…</p>}
                >
                  <WorkspaceTool
                    renderedWorkbench={panel}
                    active={active}
                    renderedSearch={
                      active && panel === workbench
                        ? location.search
                        : (searchByTool.current[panel] ?? {})
                    }
                    location={location}
                    agent={agent}
                    agents={agents}
                    onOpenBot={onOpenBot}
                    onMemory={onMemory}
                    onPendingChange={onToolPending}
                    setObjectEditing={setObjectEditing}
                    files={files}
                    sending={sending}
                    openWorkbench={openWorkbench}
                    conversation={conversation}
                  />
                </Suspense>
              </AssetBoundary>
            )}
          />
        )}
      </div>
      {!presence.panel && settingsPanel}
    </ObjectsProvider>
  )
}

function workspaceRoute(
  location: ReturnType<typeof useWorkspaceLocation>,
  selected: AgentProfile | null | undefined
) {
  const archived =
    location.pathname === "/agents/archived" ||
    (!globalSettingsSection(location.pathname) &&
      selected?.status === "archived")
  const editor =
    location.pathname === "/agents/new"
      ? { key: "new", agent: undefined }
      : location.pathname.endsWith("/edit") && selected && !archived
        ? { key: selected.id, agent: selected }
        : null
  const collection =
    archived ||
    managementBackdrop(
      location.pathname,
      location.search.returnTo,
      editor !== null
    )
  return {
    collection,
    archived,
    editor,
    settings: location.search.settings ?? null,
    workbench: location.search.panel ?? null,
    conversationId: location.agentId ?? selected?.id ?? homeAgentId,
    conversationEnabled:
      !collection &&
      (globalSettingsSection(location.pathname)
        ? !!location.search.returnTo && selected?.status === "active"
        : !!(location.agentId || selected)),
  }
}
function managementBackdrop(
  pathname: string,
  returnTo: string | undefined,
  editing: boolean
) {
  const path = editing ? returnTo?.split("?")[0] : pathname
  return path === "/agents" || path === "/agents/archived"
}

function canRenderAgent(
  agent: AgentProfile | undefined | null,
  globalSection: string | undefined,
  hasBackground: boolean
): agent is AgentProfile {
  return (
    !!agent && (!globalSection || (hasBackground && agent.status === "active"))
  )
}
function workspaceStarting(
  catalog: ReturnType<typeof useAgentCatalog>,
  conversation: ReturnType<typeof useConversation>,
  collection: boolean,
  editing: boolean,
  globalSettings: boolean,
  hasBackground: boolean
) {
  const starting =
    !catalog.error &&
    ((catalog.loading && (!globalSettings || hasBackground)) ||
      (!collection &&
        !editing &&
        !globalSettings &&
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
  active,
  renderedWorkbench,
  renderedSearch,
  location,
  agent,
  agents,
  onOpenBot,
  onMemory,
  onPendingChange,
  setObjectEditing,
  files,
  sending,
  openWorkbench,
  conversation,
}: {
  active: boolean
  renderedWorkbench: Workbench
  renderedSearch: ReturnType<typeof useWorkspaceLocation>["search"]
  location: ReturnType<typeof useWorkspaceLocation>
  agent: AgentProfile
  agents: readonly AgentProfile[]
  onOpenBot: (id: AgentProfile["id"]) => void
  onMemory: (id: AgentProfile["id"]) => void
  onPendingChange: (panel: Workbench, pending: boolean) => void
  setObjectEditing: (pending: boolean) => void
  files: FilesState
  sending: boolean
  openWorkbench: (value: Workbench | null) => void
  conversation: ReturnType<typeof useConversation>
}) {
  const current = useRef({ active, location })
  current.current = { active, location }
  // A hidden resource retains identity and drafts but cannot navigate another
  // tab through a late overlay acknowledgement or async completion.
  const update = useCallback((...args: Parameters<typeof location.update>) => {
    if (current.current.active) current.current.location.update(...args)
  }, [])
  const setItem = useCallback((item: string | null) => {
    if (current.current.active) current.current.location.setItem(item)
  }, [])
  const setTab = useCallback((tab: typeof renderedSearch.tab) => {
    if (current.current.active) current.current.location.setTab(tab)
  }, [])
  const reportPending = useCallback(
    (pending: boolean) => onPendingChange(renderedWorkbench, pending),
    [onPendingChange, renderedWorkbench]
  )
  const selected = renderedSearch.item ?? null
  const terminalTab = terminalWorkspaceTab(renderedSearch.tab)
  const memoryTab = memoryWorkspaceTab(renderedSearch.tab)
  switch (renderedWorkbench) {
    case "activity":
      return (
        <ActivityWorkbench
          active={active}
          filters={{
            scope: renderedSearch.scope,
            filter: renderedSearch.filter,
            cursor: renderedSearch.cursor,
          }}
          onFiltersChange={(value) => update(value)}
          offset={renderedSearch.offset ?? 0}
          onOffsetChange={(offset) => update({ offset: offset || undefined })}
          view={renderedSearch.tab === "tasks" ? "tasks" : "timeline"}
          inspectedAgentId={renderedSearch.activityAgent ?? agent.id}
          selected={selected}
          onSelectionChange={(tab, activityAgent, item) =>
            update({
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
            if (current.current.active) onOpenBot(id)
          }}
          onMemory={(id) => {
            if (current.current.active) onMemory(id)
          }}
          agentId={agent.id}
          agentName={agent.name}
        />
      )
    case "terminal":
      return (
        <TerminalWorkbench
          active={active}
          onPendingChange={reportPending}
          agentId={agent.id}
          selected={selected}
          onSelect={setItem}
          tab={terminalTab}
          onTabChange={setTab}
        />
      )
    case "routines":
      return (
        <RoutinesWorkbench
          active={active}
          selected={selected}
          webhook={renderedSearch.tab === "webhook"}
          onSelect={(item, webhook) =>
            update({
              item: item ?? undefined,
              tab: webhook ? "webhook" : undefined,
            })
          }
          onPendingChange={reportPending}
          agentId={agent.id}
        />
      )
    case "objects":
      return (
        <ObjectsWorkbench
          active={active}
          selected={selected}
          onSelect={setItem}
          onEditing={setObjectEditing}
        />
      )
    case "apps":
      return (
        <AppsWorkbench
          active={active}
          selected={selected}
          onSelect={setItem}
          onPendingChange={reportPending}
          agentId={agent.id}
        />
      )
    case "code":
      return (
        <ExecutionWorkbench
          onPendingChange={reportPending}
          agentId={agent.id}
          selected={selected}
          onSelect={setItem}
        />
      )
    case "browser":
      return (
        <BrowserWorkbench
          agentId={agent.id}
          agentName={agent.name}
          onPendingChange={reportPending}
        />
      )
    case "files":
      return (
        <FilesWorkbench
          active={active}
          previewView={renderedSearch.preview ?? "preview"}
          onPreviewViewChange={(preview) => update({ preview })}
          onPendingChange={reportPending}
          selected={selected}
          onSelect={setItem}
          collection={renderedSearch.tab === "trash" ? "trash" : "files"}
          onCollectionChange={setTab}
          state={files}
          selectionDisabled={sending || files.uploading}
          onAttached={() => {
            if (current.current.active) openWorkbench(null)
          }}
        />
      )
    case "memory":
      return (
        <MemoryWorkbench
          refresh={conversation.reload}
          query={renderedSearch.query ?? ""}
          onQueryChange={(query) => update({ query: query || undefined }, true)}
          state={conversation.state}
          agentId={agent.id}
          tab={memoryTab}
          onTabChange={setTab}
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
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              ref={workbenchTrigger}
              size="icon-sm"
              variant="ghost"
              disabled={editingLocked}
              aria-label={
                objectPending ? "Recover checklist save" : "Open workbench"
              }
              onClick={() => openWorkbench(objectPending ? "objects" : "files")}
            />
          }
        >
          <PanelRight aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>
          {objectPending ? "Recover checklist save" : "Open workbench"}
        </TooltipContent>
      </Tooltip>
    )
  )
}

const emptyToolQuery = {
  item: undefined,
  tab: undefined,
  preview: undefined,
  query: undefined,
  activityAgent: undefined,
  scope: undefined,
  filter: undefined,
  cursor: undefined,
  offset: undefined,
} as const

function toolQuery(search: ReturnType<typeof useWorkspaceLocation>["search"]) {
  return Object.fromEntries(
    Object.keys(emptyToolQuery).map((key) => [
      key,
      search[key as keyof typeof emptyToolQuery],
    ])
  ) as ReturnType<typeof useWorkspaceLocation>["search"]
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
  setSettings,
  agent,
  agents,
  conversation,
  onSettingsPending,
  onSettingsShown,
  openWorkbench,
  enabled = true,
}: Pick<
  Parameters<typeof AgentWorkspace>[0],
  "settings" | "location" | "setSettings" | "conversation" | "onSettingsPending"
> & {
  agent?: AgentProfile
  agents: readonly AgentProfile[]
  openWorkbench: (value: Workbench | null) => void
  onSettingsShown?: (shown: boolean) => void
  enabled?: boolean
}) {
  const category =
    enabled && (agent || isGlobalSettingsSection(settings ?? undefined))
      ? settings
      : null
  const [loaded, setLoaded] = useState(!!category)
  if (category && !loaded) setLoaded(true)
  return loaded ? (
    <AssetBoundary>
      <Suspense fallback={<p role="status">Opening settings…</p>}>
        <WorkspaceSettings
          category={category}
          onCategoryChange={setSettings}
          agent={agent}
          agents={agents}
          conversation={conversation}
          onPendingChange={onSettingsPending}
          onShownChange={onSettingsShown}
          onWorkbench={openWorkbench}
        />
      </Suspense>
    </AssetBoundary>
  ) : null
}
