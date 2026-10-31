import {
  useNavigate,
  useMatches,
  useLocation,
  useRouter,
  defaultStringifySearch,
} from "@tanstack/react-router"
import { useCallback, useMemo, useEffect } from "react"

import type { AgentId, AgentProfile } from "@/agents/contracts"
import {
  readWorkspaceNavigation,
  settingsFrames as resolveSettingsFrames,
  settingsPush,
  settingsPop as resolveSettingsPop,
  settingsHref,
  settingsBackdrop,
  type SettingsFrame,
} from "@/navigation/settings-stack"
import {
  workspaceDestination,
  editorDestination,
  workspaceReturnLink,
  workspaceContext,
  globalSettingsLink,
  isGlobalSettingsSection,
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
  const navigation = useMemo(
    () => readWorkspaceNavigation(match.context),
    [match.context]
  )
  return {
    params,
    query,
    pathname,
    href: pathname + defaultStringifySearch(query),
    navigation,
  }
}

export function useWorkspaceLocation(
  agents: readonly AgentProfile[] = noAgents,
  selected?: AgentProfile
) {
  const { params, query, href, pathname, navigation } = useWorkspaceRoute()
  const router = useRouter()
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
  const frames = useMemo(
    () => resolveSettingsFrames(href, navigation.settings),
    [href, navigation.settings]
  )
  const backdrop = settingsBackdrop(href) ?? navigation.settings?.backdrop
  const settingsLink = useCallback(
    (category: SettingsCategory, parentFrame?: SettingsFrame) => {
      const destination = isGlobalSettingsSection(category)
        ? globalSettingsLink(category, { returnTo: backdrop })
        : reference
          ? workspaceDestination(reference, {
              ...search,
              settings: category,
              security: undefined,
              connections: undefined,
            })
          : undefined
      if (!destination)
        throw new Error("Choose an agent before opening its settings.")
      return {
        ...destination,
        state: settingsPush(
          href,
          settingsHref(destination),
          navigation,
          parentFrame,
          backdrop
        ),
      }
    },
    [reference, search, backdrop, href, navigation]
  )
  const pushSettings = useCallback(
    (category: SettingsCategory, parentFrame?: SettingsFrame) => {
      void navigate(settingsLink(category, parentFrame))
    },
    [navigate, settingsLink]
  )
  const closeSettings = useCallback(() => {
    void navigate({
      ...workspaceReturnLink(
        backdrop ?? (reference ? `/agents/${reference}` : "/agents")
      ),
      state: {},
      ignoreBlocker: true,
    })
  }, [navigate, backdrop, reference])
  const popSettings = useCallback(() => {
    const current = router.history.location.state
    const pop = resolveSettingsPop(href, navigation, {
      entryKey: current.__TSR_key,
      entryIndex: current.__TSR_index,
    })
    if (pop.kind === "back") router.history.back()
    else if (pop.kind === "replace")
      void navigate({
        ...workspaceReturnLink(pop.href),
        state: pop.state,
        replace: true,
      })
    else closeSettings()
  }, [href, navigation, router, navigate, closeSettings])
  const hash = useLocation({ select: (location) => location.hash })
  useEffect(() => {
    if (!profile || contextParams.agentId === profile.slug) return
    if (globalSection) {
      if (!contextParams.agentId) return
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
        state: navigation.settings ? { piSettings: navigation.settings } : {},
        ignoreBlocker: true,
      })
      return
    }
    void navigate({
      to: pathname.replace(/^\/agents\/[^/]+/, `/agents/${profile.slug}`),
      search: query,
      hash,
      replace: true,
      state: navigation.settings ? { piSettings: navigation.settings } : {},
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
    navigation.settings,
  ])
  const update = useCallback(
    (change: Partial<WorkspaceSearch>, replace = false) => {
      const next = { ...search, ...change }
      const section = next.security ? "security" : next.settings
      if (globalSection && isGlobalSettingsSection(section)) {
        void navigate({
          ...globalSettingsLink(section, next),
          state: navigation.settings ? { piSettings: navigation.settings } : {},
          replace,
          ignoreBlocker: true,
        })
        return
      }
      if (!reference) {
        if (isGlobalSettingsSection(section))
          void navigate({
            ...globalSettingsLink(section, next),
            state: navigation.settings
              ? { piSettings: navigation.settings }
              : {},
            replace,
            ignoreBlocker: true,
          })
        else if (globalSection && !section)
          void navigate({ to: "/agents", search: {}, ignoreBlocker: true })
        return
      }
      void navigate({
        ...workspaceDestination(reference, { ...search, ...change }),
        state:
          next.settings &&
          next.settings === search.settings &&
          navigation.settings
            ? { piSettings: navigation.settings }
            : {},
        replace,
        ignoreBlocker: true,
      })
    },
    [reference, navigate, search, globalSection, navigation.settings]
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
  const openAgents = useCallback(
    () => navigate({ to: "/agents", search: {} }),
    [navigate]
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
      if (settings) pushSettings(settings)
      else closeSettings()
    },
    [pushSettings, closeSettings]
  )
  const setSecurity = useCallback(
    (open: boolean) => {
      setSettings(open ? "security" : null)
    },
    [setSettings]
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
    openAgents,
    setPanel,
    setSettings,
    settingsFrames: frames,
    settingsRoot: frames[0],
    settingsLink,
    pushSettings,
    popSettings,
    closeSettings,
    setSecurity,
    setItem,
    setTab,
  }
}
