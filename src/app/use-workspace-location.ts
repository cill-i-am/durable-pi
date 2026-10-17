import {
  useNavigate,
  useParams,
  useSearch,
  useLocation,
} from "@tanstack/react-router"
import { useCallback, useMemo } from "react"

import type { AgentId } from "@/agents/contracts"
import {
  workspaceDestination,
  editorDestination,
  workspaceReturnLink,
  workspaceView,
  type SettingsCategory,
  type Workbench,
  type WorkspaceSearch,
} from "@/navigation/workspace"

export function useWorkspaceLocation() {
  const params = useParams({ strict: false })
  const query = useSearch({ strict: false })
  const href = useLocation({ select: (location) => location.href })
  const pathname = useLocation({ select: (location) => location.pathname })
  const search = useMemo(() => workspaceView(params, query), [params, query])
  const navigate = useNavigate()
  const agentId = params.agentId
  const update = useCallback(
    (change: Partial<WorkspaceSearch>, replace = false) => {
      if (!agentId) return
      void navigate({
        ...workspaceDestination(agentId, { ...search, ...change }),
        replace,
        ignoreBlocker: true,
      })
    },
    [agentId, navigate, search]
  )
  const openAgent = useCallback(
    (id: AgentId, next: WorkspaceSearch = {}, replace = false) => {
      void navigate({
        ...workspaceDestination(id, next),
        replace,
        ignoreBlocker: true,
      })
    },
    [navigate]
  )
  const openEditor = useCallback(
    (id?: AgentId) => {
      void navigate(editorDestination(id, href))
    },
    [href, navigate]
  )
  const closeEditor = useCallback(() => {
    void navigate({
      ...workspaceReturnLink(
        query.returnTo ?? (agentId ? `/agents/${agentId}` : "/agents")
      ),
      ignoreBlocker: true,
    })
  }, [query.returnTo, agentId, navigate])
  const setQuery = useCallback(
    (q: string) => {
      if (pathname === "/agents" || pathname === "/agents/archived") {
        void navigate({
          to: pathname,
          search: { q: q || undefined },
          replace: true,
        })
      } else update({ q: q || undefined }, true)
    },
    [navigate, pathname, update]
  )
  const setPanel = useCallback(
    (panel: Workbench | null) => {
      update({
        panel: panel ?? undefined,
        settings: undefined,
        security: undefined,
        settingsView: undefined,
        connections: undefined,
        item: undefined,
        tab: undefined,
        activityAgent: undefined,
        scope: undefined,
        filter: undefined,
        cursor: undefined,
        offset: undefined,
        preview: undefined,
        query: undefined,
      })
    },
    [update]
  )
  const setSettings = useCallback(
    (settings: SettingsCategory | null) => {
      update({
        settings: settings ?? undefined,
        security: undefined,
        settingsView: undefined,
        connections: undefined,
      })
    },
    [update]
  )
  const setSecurity = useCallback(
    (open: boolean) => {
      update({
        settings: "general",
        security: open || undefined,
        settingsView: undefined,
      })
    },
    [update]
  )
  const setItem = useCallback(
    (item: string | null) =>
      update({ item: item ?? undefined, preview: undefined }),
    [update]
  )
  const setTab = useCallback(
    (tab: WorkspaceSearch["tab"]) =>
      update({
        tab,
        item: undefined,
        preview: undefined,
        offset: undefined,
        cursor: undefined,
      }),
    [update]
  )
  return {
    agentId,
    search,
    pathname,
    href,
    openEditor,
    closeEditor,
    setQuery,
    update,
    openAgent,
    setPanel,
    setSettings,
    setSecurity,
    setItem,
    setTab,
  }
}
