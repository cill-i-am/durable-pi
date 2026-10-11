import { useCallback, useEffect, useReducer, useRef, useState } from "react"
import { Schema } from "effect"
import {
  Archive,
  ChevronDown,
  Ellipsis,
  LogOut,
  Plus,
  Search,
  Settings2,
  Undo2,
} from "lucide-react"
import {
  AgentList,
  AgentProfile,
  type AgentId,
  homeAgentId,
} from "@/agents/contracts"
import { api } from "@/http/client"
import { catalogReducer, initialCatalog } from "./catalog-state"
import { authClient } from "@/auth/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
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

export function useAgentCatalog(ownerId: string) {
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
      if (!signal?.aborted)
        dispatch({ type: "loaded", request, agents: result.agents })
    } catch (error) {
      if (!signal?.aborted) dispatch({ type: "failed", request })
      if (request === requestId.current) throw error
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    try {
      setSelected(localStorage.getItem(`pi:selected:${ownerId}`) ?? homeAgentId)
    } catch {
      /* Storage may be disabled. */
    }
    void refresh(controller.signal).catch(() => {
      /* Rendered by the reducer. */
    })
    return () => controller.abort()
  }, [ownerId, refresh])
  const select = (id: AgentId) => {
    setSelected(id)
    try {
      localStorage.setItem(`pi:selected:${ownerId}`, id)
    } catch {
      /* Selection still works without storage. */
    }
  }
  return {
    ...state,
    refresh,
    select,
    selected:
      state.agents.find((a) => a.id === selected && a.status === "active") ??
      state.agents.find((a) => a.id === homeAgentId),
  }
}

export function AgentSidebar({
  disabled = false,
  agents,
  selected,
  onSelect,
  onCreate,
  onEdit,
  onArchive,
  name,
}: {
  disabled?: boolean
  agents: AgentProfile[]
  selected?: AgentProfile
  onSelect: (id: AgentId) => void
  onCreate: () => void
  onEdit: (agent: AgentProfile) => void
  onArchive: (agent: AgentProfile) => void
  name: string
}) {
  const [query, setQuery] = useState("")
  const [archived, setArchived] = useState(false)
  const { setOpenMobile } = useSidebar()
  const shown = agents.filter(
    (a) =>
      (a.status === "archived") === archived &&
      a.name.toLowerCase().includes(query.toLowerCase())
  )
  return (
    <Sidebar
      inert={disabled}
      className="workspace-sidebar"
      collapsible="offcanvas"
    >
      <SidebarHeader inert={disabled}>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" className="justify-start" />}
          >
            <span className="workspace-mark" aria-hidden="true">
              π
            </span>{" "}
            Pi <span className="text-muted-foreground">/ Personal</span>
            <ChevronDown data-icon="inline-end" />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuGroup>
              <DropdownMenuItem
                onClick={() => {
                  setOpenMobile(false)
                  onCreate()
                }}
              >
                <Plus /> New agent
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setArchived(!archived)}>
                <Archive />
                {archived ? "Active agents" : "Archived agents"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
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
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Button
          variant="outline"
          onClick={() => {
            setOpenMobile(false)
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
            {shown.map((agent) => (
              <SidebarMenuItem key={agent.id}>
                <SidebarMenuButton
                  size="lg"
                  isActive={selected?.id === agent.id}
                  onClick={() => {
                    if (agent.status === "active") {
                      onSelect(agent.id)
                      setOpenMobile(false)
                    } else onArchive(agent)
                  }}
                >
                  <span className="bot-avatar" aria-hidden="true">
                    {agent.name.slice(0, 1)}
                  </span>
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="truncate">{agent.name}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {agent.status === "archived"
                        ? "Restore agent"
                        : agent.instructions || "Your personal assistant"}
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
                          setOpenMobile(false)
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
                        {agent.status === "archived" ? <Undo2 /> : <Archive />}
                        {agent.status === "archived" ? "Restore" : "Archive"}
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </SidebarMenuItem>
            ))}
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
          onClick={() => setArchived(!archived)}
        >
          <Archive data-icon="inline-start" />
          {archived ? "Back to agents" : "Archived agents"}
        </Button>
        <div className="flex items-center gap-3 border-t pt-3">
          <span className="bot-avatar">{name.slice(0, 1)}</span>
          <span className="flex-1 text-sm">
            {name}
            <span className="block text-xs text-muted-foreground">
              Personal workspace
            </span>
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Sign out"
            onClick={() => void authClient.signOut()}
          >
            <LogOut />
          </Button>
        </div>
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
    setPending(true)
    setError("")
    try {
      const result = Schema.decodeUnknownSync(AgentProfile)(
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
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!pending) onOpenChange(value)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{agent ? "Edit agent" : "Create an agent"}</DialogTitle>
          <DialogDescription>
            Give it a name and a purpose. Its conversation and memory stay
            separate.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={save}>
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
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="agent-instructions">Instructions</FieldLabel>
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
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending ? "Saving…" : agent ? "Save changes" : "Create agent"}
            </Button>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  )
}
