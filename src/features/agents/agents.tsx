import { Link } from "@tanstack/react-router"
import { Schema } from "effect"
import {
  Archive,
  Activity,
  BookOpen,
  ChevronDown,
  ChevronsUpDown,
  Ellipsis,
  LogOut,
  Plus,
  Search,
  Settings2,
  Undo2,
} from "lucide-react"
import { useCallback, useEffect, useReducer, useRef, useState } from "react"

import {
  AgentList,
  AgentProfileResponse,
  AgentProfile,
  type AgentId,
  homeAgentId,
} from "@/agents/contracts"
import { authClient } from "@/auth/client"
import { AgentMark, agentTone } from "@/components/agent-mark"
import { AgentStatusMarker, agentStatusLabel } from "@/components/agent-status"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuAction,
  SidebarInput,
  useSidebar,
} from "@/components/ui/sidebar"
import { Textarea } from "@/components/ui/textarea"
import { UserAvatar } from "@/components/user-avatar"
import type { RuntimeStatus } from "@/conversations/status"
import { markReady } from "@/features/performance"
import { api } from "@/http/client"
import {
  workspaceDestination,
  type WorkspaceSearch,
} from "@/navigation/workspace"

import { catalogReducer, initialCatalog } from "./catalog-state"

export function useAgentCatalog(ownerId: string, selectedId?: string) {
  const [state, dispatch] = useReducer(catalogReducer, initialCatalog)
  const [selected, setSelected] = useState<string>(homeAgentId)
  const requestId = useRef(0)
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const request = ++requestId.current
    dispatch({ type: "start", request })
    try {
      const result = Schema.decodeUnknownSync(AgentList)(
        await api("/api/agent/bots", undefined, signal)
      )
      if (!signal?.aborted) {
        markReady("catalog")
        dispatch({ type: "loaded", request, agents: result.agents })
      }
    } catch (error) {
      if (!signal?.aborted) dispatch({ type: "failed", request })
      if (request === requestId.current) throw error
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    try {
      setSelected(localStorage.getItem(`pi:selected:${ownerId}`) ?? homeAgentId)
    } catch {}
    void refresh(controller.signal).catch(() => {})
    return () => controller.abort()
  }, [ownerId, refresh])
  useEffect(() => {
    const agent = state.agents.find(
      (agent) =>
        (agent.id === selectedId || agent.slug === selectedId) &&
        agent.status === "active"
    )
    if (!agent) return
    try {
      localStorage.setItem(`pi:selected:${ownerId}`, agent.id)
    } catch {}
  }, [selectedId, ownerId, state.agents])
  const select = (id: AgentId) => {
    setSelected(id)
    try {
      localStorage.setItem(`pi:selected:${ownerId}`, id)
    } catch {}
  }
  return {
    ...state,
    refresh,
    select,
    selected: selectedId
      ? state.agents.find((a) => a.id === selectedId || a.slug === selectedId)
      : (state.agents.find((a) => a.id === selected && a.status === "active") ??
        state.agents.find((a) => a.id === homeAgentId)),
  }
}

export function AgentSidebar({
  disabled = false,
  agents,
  statuses,
  selected,
  query,
  onQuery,
  archived,
  view,
  onCreate,
  onEdit,
  onArchive,
  onActivity,
  onMemory,
  onSettings,
  name,
  image,
}: {
  disabled?: boolean
  agents: AgentProfile[]
  statuses: Readonly<Record<string, RuntimeStatus>>
  selected?: AgentProfile
  query: string
  onQuery: (query: string) => void
  archived: boolean
  view: WorkspaceSearch
  onCreate: () => void
  onEdit: (agent: AgentProfile) => void
  onArchive: (agent: AgentProfile) => void
  onActivity: () => void
  onMemory: () => void
  onSettings: () => void
  name: string
  image?: string | null
}) {
  const { setOpenMobile, isMobile } = useSidebar()
  const shown = agents.filter(
    (a) =>
      (a.status === "archived") === archived &&
      a.name.toLowerCase().includes(query.toLowerCase())
  )
  return (
    <Sidebar
      role="navigation"
      aria-label="Agents and workspace"
      inert={disabled}
      className="workspace-sidebar"
      collapsible="offcanvas"
    >
      <SidebarHeader inert={disabled}>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" className="justify-start md:hidden" />
            }
          >
            <AgentMark />
            Pi <span className="text-muted-foreground">/ Personal</span>
            <ChevronDown data-icon="inline-end" />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuGroup>
              <DropdownMenuItem
                onClick={() => {
                  onCreate()
                }}
              >
                <Plus /> New agent
              </DropdownMenuItem>
              <DropdownMenuItem
                render={<Link to={archived ? "/agents" : "/agents/archived"} />}
                onClick={() => setOpenMobile(false)}
              >
                <Archive />
                {archived ? "Active agents" : "Archived agents"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => {
                  onSettings()
                }}
              >
                <Settings2 />
                Settings
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void authClient.signOut()}>
                <LogOut />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="relative">
          <Search className="absolute top-2 left-2 size-4 text-muted-foreground" />
          <SidebarInput
            className="pl-8"
            aria-label="Search agents"
            placeholder="Search agents…"
            maxLength={200}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
          />
        </div>
        <Button
          variant="outline"
          className="h-9.5 justify-start"
          onClick={() => {
            onCreate()
          }}
        >
          <Plus data-icon="inline-start" />
          New agent
        </Button>
      </SidebarHeader>
      <SidebarContent inert={disabled}>
        <SidebarGroup>
          <SidebarGroupLabel>
            {archived ? "Archived agents" : "Your agents"}
          </SidebarGroupLabel>
          <SidebarMenu>
            {shown.map((agent) => {
              const state =
                agent.status === "archived"
                  ? "archived"
                  : statuses[agent.id]?.state
              const label = `${agent.name}: ${agentStatusLabel(state)}`
              return (
                <SidebarMenuItem key={agent.id}>
                  <SidebarMenuButton
                    size="lg"
                    isActive={selected?.id === agent.id}
                    aria-label={label}
                    tooltip={{ children: label, hidden: isMobile }}
                    render={
                      <Link
                        to="/agents/$agentId"
                        params={{ agentId: agent.slug }}
                      />
                    }
                    onClick={() => setOpenMobile(false)}
                  >
                    <span className="agent-avatar">
                      <AgentMark tone={agentTone(agent.id)} />
                      <AgentStatusMarker status={state} />
                    </span>
                    <span className="agent-sidebar-copy flex min-w-0 flex-col gap-0.5">
                      <span className="truncate">{agent.name}</span>
                      <span className="truncate font-normal text-muted-foreground">
                        {agent.instructions || "Your personal assistant"}
                      </span>
                    </span>
                  </SidebarMenuButton>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <SidebarMenuAction
                          showOnHover
                          aria-label={`Options for ${agent.name}`}
                        />
                      }
                    >
                      <Ellipsis />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuGroup>
                        <DropdownMenuItem
                          onClick={() => {
                            onEdit(agent)
                          }}
                        >
                          <Settings2 />
                          Edit agent
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={agent.id === homeAgentId}
                          onClick={() => onArchive(agent)}
                        >
                          {agent.status === "archived" ? (
                            <Undo2 />
                          ) : (
                            <Archive />
                          )}
                          {agent.status === "archived" ? "Restore" : "Archive"}
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </SidebarMenuItem>
              )
            })}
          </SidebarMenu>
          {!shown.length && (
            <p className="p-2 text-xs text-muted-foreground">
              {query
                ? "No matching agents."
                : archived
                  ? "No archived agents."
                  : "Your agents will appear here."}
            </p>
          )}
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter inert={disabled}>
        <Button
          variant="ghost"
          className="justify-start"
          onClick={() => {
            onActivity()
          }}
        >
          <Activity />
          Activity
        </Button>
        <Button
          variant="ghost"
          className="justify-start"
          onClick={() => {
            onMemory()
          }}
        >
          <BookOpen />
          Memory
        </Button>
        <SidebarMenu className="account-menu border-t pt-2">
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton
                    size="lg"
                    className="account-menu-trigger aria-expanded:bg-muted"
                  />
                }
                aria-label={`Settings for ${name}`}
              >
                <UserAvatar name={name} image={image} />
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-sm font-medium">
                    {name}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    Personal workspace
                  </span>
                </span>
                <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="min-w-56"
                side={isMobile ? "top" : "right"}
                align="end"
                sideOffset={8}
              >
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="px-2 py-2">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {name}
                    </span>
                    <span className="block font-normal">
                      Personal workspace
                    </span>
                  </DropdownMenuLabel>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    render={
                      selected ? (
                        <Link
                          {...workspaceDestination(selected.id, {
                            ...view,
                            settings: "settings",
                            security: undefined,
                            connections: undefined,
                          })}
                        />
                      ) : undefined
                    }
                    onClick={() => {
                      setOpenMobile(false)
                      if (!selected) onSettings()
                    }}
                  >
                    <Settings2 /> Settings
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    render={
                      <Link to={archived ? "/agents" : "/agents/archived"} />
                    }
                    onClick={() => setOpenMobile(false)}
                  >
                    <Archive /> {archived ? "Active agents" : "Archived agents"}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => void authClient.signOut()}>
                  <LogOut /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}

export function AgentEditor({
  agent,
  open,
  onOpenChange,
  onSaved,
}: {
  agent?: AgentProfile
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (agent: AgentProfile) => Promise<void>
}) {
  const [name, setName] = useState(agent?.name ?? "")
  const [instructions, setInstructions] = useState(agent?.instructions ?? "")
  const [error, setError] = useState("")
  const [pending, setPending] = useState(false)
  const id = useRef(agent?.id ?? crypto.randomUUID())
  async function save(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setError("")
    try {
      const result = Schema.decodeUnknownSync(AgentProfileResponse)(
        await api(`/api/agent/bots/${agent ? "update" : "create"}`, {
          id: id.current,
          name: name.trim(),
          instructions,
        })
      )
      await onSaved(result)
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save this agent.")
    } finally {
      setPending(false)
    }
  }
  return (
    <Sheet
      open={open}
      dismissible={!pending}
      onOpenChange={(value) => {
        if (!pending) onOpenChange(value)
      }}
    >
      <SheetContent className="agent-editor agent-editor-sheet">
        <SheetHeader>
          <SheetTitle>
            {agent ? "Agent settings" : "Create an agent"}
          </SheetTitle>
          <SheetDescription>Give it a name and a purpose.</SheetDescription>
        </SheetHeader>
        <form onSubmit={save}>
          <div className="agent-editor-preview">
            <AgentMark tone={agentTone(id.current)} />
            <span>{name || "A new point of view"}</span>
          </div>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="agent-name">Name</FieldLabel>
              <Input
                id="agent-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Research, Studio, Home…"
                maxLength={80}
                required
                pattern=".*\S.*"
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="agent-instructions">Purpose</FieldLabel>
              <Textarea
                id="agent-instructions"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="What should this agent help with?"
                rows={4}
                maxLength={8000}
              />
              <FieldDescription>
                You can change these later. Updates apply to new turns.
              </FieldDescription>
            </Field>
            {error && (
              <Alert>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Saving…" : agent ? "Save changes" : "Create agent"}
              </Button>
            </div>
          </FieldGroup>
        </form>
      </SheetContent>
    </Sheet>
  )
}
