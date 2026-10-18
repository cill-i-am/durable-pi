import {
  defaultParseSearch,
  defaultStringifySearch,
} from "@tanstack/react-router"
import { Schema } from "effect"

import { ActivityFilter, ActivityCursor } from "@/activity/contracts"
import { AgentId } from "@/agents/contracts"
import { AgentSlug } from "@/agents/slugs"

export const AgentReference = Schema.Union([AgentId, AgentSlug])
export type AgentReference = typeof AgentReference.Type
export const parseAgentReference = Schema.decodeUnknownSync(AgentReference)

export const Workbench = Schema.Literals([
  "browser",
  "code",
  "apps",
  "terminal",
  "routines",
  "objects",
  "activity",
  "files",
  "memory",
])
export type Workbench = typeof Workbench.Type
export const SettingsCategory = Schema.Literals([
  "family",
  "model-access",
  "general",
  "models",
  "access",
  "skills",
  "memory",
  "connections",
])
export type SettingsCategory = typeof SettingsCategory.Type
export const SettingsSection = Schema.Literals([
  "family",
  "model-access",
  "general",
  "models",
  "access",
  "skills",
  "memory",
  "connections",
  "security",
])
export const ResourceId = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9_:-]{1,200}$/)
)
const Tab = Schema.Literals([
  "files",
  "trash",
  "notes",
  "history",
  "tree",
  "commands",
  "interactive",
  "transfers",
  "tasks",
  "timeline",
  "webhook",
])
const Search = Schema.Struct({
  tab: Schema.optional(Tab),
  settingsView: Schema.optional(Schema.Literals(["sections", "detail"])),
  preview: Schema.optional(Schema.Literals(["preview", "source"])),
  scope: Schema.optional(Schema.Union([AgentId, Schema.Literals(["all"])])),
  filter: Schema.optional(ActivityFilter),
  cursor: Schema.optional(ActivityCursor),
  offset: Schema.optional(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(100000)
    )
  ),
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  q: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  activityAgent: Schema.optional(AgentId),
  connections: Schema.optional(Schema.Literals(["connected", "failed"])),
  panel: Schema.optional(Workbench),
  item: Schema.optional(ResourceId),
})
export type WorkspaceQuery = typeof Search.Type
export type WorkspaceSearch = WorkspaceQuery & {
  settings?: SettingsCategory
  security?: boolean
}
export const validateWorkspaceSearch = Schema.decodeUnknownSync(Search)
export const parseAgentId = Schema.decodeUnknownSync(AgentId)
export const parsePanel = Schema.decodeUnknownSync(Workbench)
export const parseSection = Schema.decodeUnknownSync(SettingsSection)
export const parseResourceId = Schema.decodeUnknownSync(ResourceId)
const tabs: Record<Workbench, readonly NonNullable<WorkspaceQuery["tab"]>[]> = {
  browser: [],
  code: [],
  apps: [],
  objects: [],
  terminal: ["commands", "interactive", "transfers"],
  routines: ["webhook"],
  activity: ["timeline", "tasks"],
  files: ["files", "trash"],
  memory: ["notes", "history", "tree", "files"],
}
const WorkspaceParams = Schema.Struct({
  agentId: Schema.optional(AgentReference),
  panel: Schema.optional(Workbench),
  itemId: Schema.optional(ResourceId),
  section: Schema.optional(SettingsSection),
})
export type WorkspaceParams = typeof WorkspaceParams.Type

export function workspaceView(
  params: WorkspaceParams,
  query: WorkspaceQuery
): WorkspaceSearch {
  if (!params.section && (query.panel || query.item))
    throw new Error("Resource identity belongs in the page path.")
  const view: WorkspaceSearch = {
    ...query,
    panel: params.section ? query.panel : params.panel,
    item: params.section ? query.item : params.itemId,
    settings: params.section === "security" ? "general" : params.section,
    security: params.section === "security" || undefined,
  }
  validatePanelSelection(view)
  validateWorkspaceFilters(view, params)
  return view
}

function validateWorkspaceFilters(
  view: WorkspaceSearch,
  params: WorkspaceParams
) {
  if (view.connections && params.agentId && !params.section)
    throw new Error("Connection results belong to Settings.")
  if (view.settingsView && !params.section)
    throw new Error("Settings presentation belongs to Settings.")
  if (
    (view.scope || view.filter || view.cursor || view.offset !== undefined) &&
    view.panel !== "activity"
  )
    throw new Error("Activity filters belong to Activity.")
  if (view.preview && (view.panel !== "files" || !view.item))
    throw new Error("A file preview requires a selected file.")
  if (view.query && view.panel !== "memory")
    throw new Error("Archive search belongs to Memory.")
}

function validatePanelSelection(view: WorkspaceSearch) {
  if (view.tab && (!view.panel || !tabs[view.panel].includes(view.tab)))
    throw new Error("This tab does not belong to the selected workspace panel.")
  if (
    view.item &&
    (!view.panel || view.panel === "browser" || view.panel === "memory")
  )
    throw new Error("This panel does not select a saved resource.")
  if (view.activityAgent && view.panel !== "activity")
    throw new Error("An activity agent requires the Activity panel.")
}

export function workspaceDestination(
  agentId: AgentReference,
  view: WorkspaceSearch = {}
) {
  const { panel, item, settings, security, ...query } = view
  if (settings || security) {
    return {
      to: "/agents/$agentId/settings/$section" as const,
      params: {
        agentId,
        section: security ? ("security" as const) : (settings ?? "general"),
      },
      search: { ...query, panel, item },
    }
  }
  if (panel && item)
    return {
      to: "/agents/$agentId/$panel/$itemId" as const,
      params: { agentId, panel, itemId: parseResourceId(item) },
      search: query,
    }
  if (panel)
    return {
      to: "/agents/$agentId/$panel" as const,
      params: { agentId, panel },
      search: query,
    }
  return { to: "/agents/$agentId" as const, params: { agentId }, search: query }
}

export function workspaceReturnPath(value: string, depth = 0): string {
  try {
    if (depth > 3) return "/"
    const url = new URL(value, "https://workspace.invalid")
    if (url.origin !== "https://workspace.invalid" || url.hash) return "/"
    const parts = url.pathname
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent)
    const query = validateWorkspaceSearch(defaultParseSearch(url.search))
    if (parts[0] !== "agents") return "/"
    if (parts.length === 1 || (parts.length === 2 && parts[1] === "archived")) {
      const q = defaultStringifySearch({ q: query.q })
      return `${parts.length === 1 ? "/agents" : "/agents/archived"}${q}`
    }
    if (parts.length === 2 && parts[1] === "new") {
      const returnTo = url.searchParams.get("returnTo")
      return `/agents/new${defaultStringifySearch({ returnTo: returnTo ? workspaceReturnPath(returnTo, depth + 1) : undefined })}`
    }
    const agentId = parseAgentReference(parts[1])
    if (parts.length === 3 && parts[2] === "edit") {
      const returnTo = url.searchParams.get("returnTo")
      return `/agents/${agentId}/edit${defaultStringifySearch({ returnTo: returnTo ? workspaceReturnPath(returnTo, depth + 1) : undefined })}`
    }
    if (![2, 3, 4].includes(parts.length)) return "/"
    if (parts.length === 3 && parts[2] === "settings") {
      workspaceView({ agentId, section: "general" }, query)
      return `/agents/${agentId}/settings/general${defaultStringifySearch(query)}`
    }
    const params = agentWorkspaceParams(parts, agentId)
    workspaceView(params, query)
    return `${url.pathname}${defaultStringifySearch(query)}`
  } catch {
    return "/"
  }
}

function agentWorkspaceParams(
  parts: string[],
  agentId: AgentReference
): WorkspaceParams {
  return parts[2] === "settings" && parts.length === 4
    ? { agentId, section: parseSection(parts[3]) }
    : parts.length >= 3
      ? {
          agentId,
          panel: parsePanel(parts[2]),
          itemId: parts[3] ? parseResourceId(parts[3]) : undefined,
        }
      : { agentId }
}

const AuthSearch = Schema.Struct({
  returnTo: Schema.optional(Schema.String.check(Schema.isMaxLength(2000))),
})
const decodeAuthSearch = Schema.decodeUnknownSync(AuthSearch)
export function validateAuthSearch(input: unknown): { returnTo?: string } {
  const value = decodeAuthSearch(input)
  return {
    returnTo: value.returnTo ? authReturnPath(value.returnTo) : undefined,
  }
}
export function authReturnPath(value: string) {
  return value === "/join" ? "/join" : workspaceReturnPath(value)
}
export function workspaceReturnLink(value: string) {
  const url = new URL(workspaceReturnPath(value), "https://workspace.invalid")
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent)
  const search = validateWorkspaceSearch(defaultParseSearch(url.search))
  if (!parts.length) return { to: "/" as const, search: {} }
  if (parts.length === 1)
    return { to: "/agents" as const, search: { q: search.q } }
  if (parts[1] === "archived")
    return { to: "/agents/archived" as const, search: { q: search.q } }
  if (parts[1] === "new")
    return editorDestination(
      undefined,
      url.searchParams.get("returnTo") ?? "/agents"
    )
  const agentId = parseAgentReference(parts[1])
  if (parts[2] === "edit")
    return editorDestination(
      agentId,
      url.searchParams.get("returnTo") ?? `/agents/${agentId}`
    )
  return workspaceDestination(
    agentId,
    workspaceView(
      {
        agentId,
        ...(parts[2] === "settings"
          ? { section: parseSection(parts[3]) }
          : parts[2]
            ? { panel: parsePanel(parts[2]), itemId: parts[3] }
            : {}),
      },
      search
    )
  )
}

export function editorDestination(
  agentId?: AgentReference,
  returnTo = "/agents"
) {
  const search = { returnTo: workspaceReturnPath(returnTo) }
  return agentId
    ? { to: "/agents/$agentId/edit" as const, params: { agentId }, search }
    : { to: "/agents/new" as const, search }
}
