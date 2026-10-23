import {
  useNavigate,
  useMatches,
  useLocation,
  defaultStringifySearch,
} from "@tanstack/react-router"
import { useCallback, useMemo, useEffect } from "react"

import type { AgentId, AgentProfile } from "@/agents/contracts"
import {
  workspaceDestination,
  editorDestination,
  workspaceReturnLink,
  workspaceContext,
  globalSettingsLink,
  parseWorkspaceParams,
  workspaceRouteSearch,
  type SettingsCategory,
  type Workbench,
  type WorkspaceSearch,
  type WorkspaceQuery,
  type GlobalSettingsQuery,
} from "@/navigation/workspace"

const noAgents: readonly AgentProfile[] = []
/** Location advances before matches commit; identity and view must share one snapshot. */
export function useWorkspaceRoute() {
  const match = useMatches({ select: (matches) => matches.at(-1)! })
  const params = useMemo(
    () => parseWorkspaceParams(match.params),
    [match.params]
  )
  const query: WorkspaceQuery & GlobalSettingsQuery = useMemo(
    () => workspaceRouteSearch(match.pathname, match.search),
    [match.pathname, match.search]
  )
  const pathname = match.pathname
  return {
    params,
    query,
    pathname,
    href: pathname + defaultStringifySearch(query),
  }
}

export function useWorkspaceLocation(
  agents: readonly AgentProfile[] = noAgents,
  selected?: AgentProfile
) {
  const { params, query, href, pathname } = useWorkspaceRoute()
  const {
    globalSection,
    params: contextParams,
    view: search,
    backgroundPath,
  } = useMemo(
    () => workspaceContext(pathname, params, query),
    [pathname, params, query]
  )
  const navigate = useNavigate()
  const profile =
    agents.find(
      (agent) =>
        agent.id === contextParams.agentId ||
        agent.slug === contextParams.agentId
    ) ?? (globalSection && !contextParams.agentId ? selected : undefined)
  const agentId = profile?.id
  const reference = profile?.slug ?? contextParams.agentId
  const hash = useLocation({ select: (location) => location.hash })
  useEffect(() => {
    if (!profile || contextParams.agentId === profile.slug) return
    if (globalSection) {
      void navigate({
        to: pathname,
        search: {
          ...query,
          returnTo: backgroundPath
            ? backgroundPath.replace(
                /^\/agents\/[^/?]+/,
                `/agents/${profile.slug}`
              )
            : `/agents/${profile.slug}`,
        },
        replace: true,
        ignoreBlocker: true,
      })
      return
    }
    void navigate({
      to: pathname.replace(/^\/agents\/[^/]+/, `/agents/${profile.slug}`),
      search: query,
      hash,
      replace: true,
      ignoreBlocker: true,
    })
  }, [
    profile,
    contextParams.agentId,
    globalSection,
    backgroundPath,
    pathname,
    query,
    hash,
    navigate,
  ])
  const update = useCallback(
    (change: Partial<WorkspaceSearch>, replace = false) => {
      if (!reference) {
        const next = { ...search, ...change }
        const section = next.security ? "security" : next.settings
        if (
          globalSection &&
          (section === "family" ||
            section === "model-access" ||
            section === "security")
        )
          void navigate({
            ...globalSettingsLink(section, next),
            replace,
            ignoreBlocker: true,
          })
        else if (globalSection && !section)
          void navigate({ to: "/agents", search: {}, ignoreBlocker: true })
        return
      }
      void navigate({
        ...workspaceDestination(reference, { ...search, ...change }),
        replace,
        ignoreBlocker: true,
      })
    },
    [reference, navigate, search, globalSection]
  )
  const openAgent = useCallback(
    (id: AgentId, next: WorkspaceSearch = {}, replace = false) => {
      return navigate({
        ...workspaceDestination(
          agents.find((agent) => agent.id === id)?.slug ?? id,
          next
        ),
        replace,
        ignoreBlocker: true,
      })
    },
    [navigate, agents]
  )
  const openEditor = useCallback(
    (id?: AgentId) => {
      void navigate(
        editorDestination(
          agents.find((agent) => agent.id === id)?.slug ?? id,
          href
        )
      )
    },
    [href, navigate, agents]
  )
  const openArchivedAgents = useCallback(
    (replace = false) =>
      navigate({
        to: "/agents/archived",
        search: {},
        replace,
        ignoreBlocker: true,
      }),
    [navigate]
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
        returnTo: undefined,
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
      if (!open && globalSection && !profile) {
        void navigate({
          ...workspaceReturnLink(query.returnTo ?? "/agents"),
          ignoreBlocker: true,
        })
        return
      }
      update({
        settings: "general",
        security: open || undefined,
        settingsView: undefined,
      })
    },
    [update, globalSection, profile, navigate, query.returnTo]
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
    reference,
    search,
    pathname,
    href,
    openEditor,
    closeEditor,
    setQuery,
    update,
    openAgent,
    openArchivedAgents,
    setPanel,
    setSettings,
    setSecurity,
    setItem,
    setTab,
  }
}
