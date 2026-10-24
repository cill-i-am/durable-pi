import {
  defaultParseSearch,
  defaultStringifySearch,
} from "@tanstack/react-router"

import {
  globalSettingsSection,
  isAgentSettingsIndex,
  parseAgentReference,
  parseSection,
  workspaceBackdrop,
  workspaceReturnPath,
  workspaceRouteSearch,
  workspaceDestination,
  workspaceView,
  type SettingsCategory,
} from "./workspace"

export type SettingsFrame = {
  readonly id: string
  readonly href: string
  readonly category: SettingsCategory
}
type ParentEntry = { key: string; index: number; href: string }
export type SettingsHistory = {
  version: 1
  parents: readonly string[]
  backdrop?: string
  from?: ParentEntry
}
declare module "@tanstack/react-router" {
  interface HistoryState {
    piSettings?: SettingsHistory
  }
}
export type WorkspaceNavigation = {
  settings?: SettingsHistory
  entryKey?: string
  entryIndex?: number
}
const maxFrames = 16
const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined

export function settingsRoute(value: string): SettingsFrame | undefined {
  try {
    let href = workspaceReturnPath(value)
    if (href === "/") return
    const url = new URL(href, "https://workspace.invalid")
    url.pathname = url.pathname.replace(/\/$/, "")
    href = url.pathname + url.search
    const global = globalSettingsSection(url.pathname)
    if (global) return { id: url.pathname, href, category: global }
    const parts = url.pathname
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent)
    if (
      parts[0] !== "agents" ||
      parts[2] !== "settings" ||
      ![3, 4].includes(parts.length)
    )
      return
    parseAgentReference(parts[1])
    return {
      id: url.pathname,
      href,
      category: isAgentSettingsIndex(url.pathname)
        ? "agent-settings"
        : parseSection(parts[3]),
    }
  } catch {
    return
  }
}

function readParentEntry(value: unknown): ParentEntry | undefined {
  const raw = object(value)
  const frame =
    typeof raw?.href === "string" ? settingsRoute(raw.href) : undefined
  if (
    !frame ||
    typeof raw?.key !== "string" ||
    !raw.key.length ||
    raw.key.length > 200 ||
    !Number.isSafeInteger(raw.index) ||
    (raw.index as number) < 0
  )
    return
  return { key: raw.key, index: raw.index as number, href: frame.href }
}

export function readSettingsHistory(
  value: unknown
): SettingsHistory | undefined {
  const input = object(value)
  if (
    input?.version !== 1 ||
    !Array.isArray(input.parents) ||
    input.parents.length >= maxFrames
  )
    return
  const parents: string[] = []
  const ids = new Set<string>()
  for (const path of input.parents) {
    const frame =
      typeof path === "string" && path.length <= 4000
        ? settingsRoute(path)
        : undefined
    if (!frame || ids.has(frame.id)) return
    ids.add(frame.id)
    parents.push(frame.href)
  }
  const root = parents[0] && settingsRoute(parents[0])
  if (
    root &&
    root.category !== "settings" &&
    root.category !== "agent-settings"
  )
    return
  return {
    version: 1,
    parents,
    backdrop:
      typeof input.backdrop === "string"
        ? workspaceBackdrop(input.backdrop)?.path
        : undefined,
    from: readParentEntry(input.from),
  }
}

/** Capture navigation metadata during the same route load as params/search. */
export function workspaceNavigationContext({
  location,
}: {
  location: { state: unknown }
}) {
  const state = object(location.state)
  return {
    workspaceNavigation: {
      settings: readSettingsHistory(state?.piSettings),
      entryKey:
        typeof state?.__TSR_key === "string" ? state.__TSR_key : undefined,
      entryIndex: Number.isSafeInteger(state?.__TSR_index)
        ? (state?.__TSR_index as number)
        : undefined,
    } satisfies WorkspaceNavigation,
  }
}

export function readWorkspaceNavigation(context: unknown): WorkspaceNavigation {
  const value = object(object(context)?.workspaceNavigation)
  if (!value) return {}
  return {
    settings: readSettingsHistory(value.settings),
    entryKey: typeof value.entryKey === "string" ? value.entryKey : undefined,
    entryIndex: Number.isSafeInteger(value.entryIndex)
      ? (value.entryIndex as number)
      : undefined,
  }
}

function parentFrame(frame: SettingsFrame): SettingsFrame | undefined {
  const url = new URL(frame.href, "https://workspace.invalid")
  if (frame.category === "settings" || frame.category === "agent-settings")
    return
  if (url.pathname.startsWith("/agents/")) {
    url.pathname = url.pathname.replace(/\/settings\/[^/]+\/?$/, "/settings")
  } else {
    url.pathname = frame.category === "model-access" ? "/family" : "/settings"
    url.searchParams.delete("connections")
  }
  return settingsRoute(url.pathname + url.search)
}

export function settingsFrames(
  href: string,
  history?: SettingsHistory
): readonly SettingsFrame[] {
  const current = settingsRoute(href)
  if (!current) return []
  const saved = readSettingsHistory(history)
  if (
    saved &&
    (saved.parents.length > 0 ||
      current.category === "settings" ||
      current.category === "agent-settings") &&
    !saved.parents.some((path) => settingsRoute(path)?.id === current.id)
  ) {
    return [...saved.parents.map((path) => settingsRoute(path)!), current]
  }
  const frames = [current]
  for (let parent = parentFrame(current); parent; parent = parentFrame(parent))
    frames.unshift(parent)
  return frames
}

export function settingsPush(
  currentHref: string,
  targetHref: string,
  navigation: WorkspaceNavigation,
  parent?: SettingsFrame,
  backdrop?: string
) {
  const target = settingsRoute(targetHref)
  if (!target) throw new Error("Settings navigation requires a settings route.")
  const current = settingsFrames(currentHref, navigation.settings)
  const parentIndex = parent
    ? current.findIndex((frame) => frame.id === parent.id)
    : current.length - 1
  if (parent && parentIndex < 0)
    throw new Error("The settings parent is no longer mounted.")
  const prefix = current.slice(0, parentIndex + 1)
  const ancestor = prefix.findIndex((frame) => frame.id === target.id)
  const parents = ancestor >= 0 ? prefix.slice(0, ancestor) : prefix
  // Opening a direct leaf still mounts its canonical list/ancestor frames.
  const normalized = parents.length
    ? parents
    : settingsFrames(target.href).slice(0, -1)
  if (normalized.length >= maxFrames)
    throw new Error("Close a settings page before opening another.")
  const canonicalCurrent = settingsRoute(currentHref)?.href
  const from =
    navigation.entryKey &&
    navigation.entryIndex !== undefined &&
    normalized.at(-1)?.href === canonicalCurrent
      ? {
          key: navigation.entryKey,
          index: navigation.entryIndex,
          href: canonicalCurrent!,
        }
      : undefined
  return {
    piSettings: {
      version: 1,
      parents: normalized.map((frame) => frame.href),
      backdrop: workspaceBackdrop(
        backdrop ?? navigation.settings?.backdrop ?? ""
      )?.path,
      from,
    } satisfies SettingsHistory,
  }
}

export function settingsPop(
  href: string,
  navigation: WorkspaceNavigation,
  currentEntry?: Pick<WorkspaceNavigation, "entryKey" | "entryIndex">
) {
  const frames = settingsFrames(href, navigation.settings)
  const parent = frames.at(-2)
  if (!parent) return { kind: "close" as const }
  const recorded =
    navigation.settings?.parents.length === frames.length - 1 &&
    navigation.settings.parents.every(
      (path, index) => settingsRoute(path)?.href === frames[index]?.href
    )
  const from = recorded ? navigation.settings?.from : undefined
  const sameEntry =
    !currentEntry ||
    (currentEntry.entryKey === navigation.entryKey &&
      currentEntry.entryIndex === navigation.entryIndex)
  if (
    from &&
    from.href === parent.href &&
    navigation.entryIndex === from.index + 1 &&
    sameEntry
  )
    return { kind: "back" as const }
  return {
    kind: "replace" as const,
    href: parent.href,
    state: {
      piSettings: {
        version: 1,
        parents: frames.slice(0, -2).map((frame) => frame.href),
        backdrop: navigation.settings?.backdrop,
      } satisfies SettingsHistory,
    },
  }
}

export function settingsHref(destination: {
  to: string
  params?: object
  search?: object
}) {
  return (
    destination.to.replace(/\$(\w+)/g, (_, key: string) =>
      encodeURIComponent(String(object(destination.params)?.[key]))
    ) + defaultStringifySearch(destination.search ?? {})
  )
}

export function settingsBackdrop(href: string): string | undefined {
  const frame = settingsRoute(href)
  if (!frame) return workspaceBackdrop(href)?.path
  const url = new URL(frame.href, "https://workspace.invalid")
  const query = workspaceRouteSearch(
    url.pathname,
    defaultParseSearch(url.search)
  )
  if ("returnTo" in query && query.returnTo)
    return workspaceBackdrop(query.returnTo)?.path
  if (!url.pathname.startsWith("/agents/")) return
  const reference = parseAgentReference(url.pathname.split("/")[2])
  const view = workspaceView(
    { agentId: reference, section: "agent-settings" },
    query
  )
  return workspaceBackdrop(
    settingsHref(
      workspaceDestination(reference, { ...view, settings: undefined })
    )
  )?.path
}
