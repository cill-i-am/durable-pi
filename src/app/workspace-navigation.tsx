import { Link } from "@tanstack/react-router"
import { AgentAvatar } from "@workspace/ui/components/agent-avatar"
import { Button } from "@workspace/ui/components/button"
import {
  Activity,
  BookOpen,
  ChevronDown,
  Archive,
  MoreHorizontal,
  Pencil,
  LayoutGrid,
  Clock3,
  Code2,
  Globe,
  Files,
  ListTodo,
  LogOut,
  PanelsTopLeft,
  Plus,
  Search,
  Settings2,
  TerminalSquare,
} from "lucide-react"
import { useRef } from "react"

import { homeAgentId, type AgentProfile } from "@/agents/contracts"
import { AgentStatusMarker, agentStatusLabel } from "@/components/agent-status"
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuAction,
  SidebarMenuButton,
  useSidebar,
} from "@/components/ui/sidebar"
import { UserAvatar } from "@/components/user-avatar"
import type { RuntimeStatus } from "@/conversations/status"
import { useFamily } from "@/features/family/context"

export type { Workbench } from "@/navigation/workspace"
export type { WorkspaceAction } from "./workspace-command.machine"
import { useWorkspaceCommand } from "./use-workspace-command"
import type { WorkspaceAction } from "./workspace-command.machine"

const destinations = [
  { id: "activity", label: "Activity", icon: Activity },
  { id: "objects", label: "Checklists", icon: ListTodo },
  { id: "files", label: "Files", icon: Files },
  { id: "memory", label: "Memory", icon: BookOpen },
  { id: "apps", label: "Apps", icon: PanelsTopLeft },
  { id: "browser", label: "Browser", icon: Globe },
  { id: "terminal", label: "Terminal", icon: TerminalSquare },
  { id: "code", label: "Code", icon: Code2 },
  { id: "routines", label: "Routines", icon: Clock3 },
] as const

export function WorkspaceNavigation({
  name,
  image,
  agents,
  collection,
  statuses,
  selected,
  locked,
  onAction,
  onSelect,
  onCollection,
  onAgentSettings,
  onEdit,
  onArchive,
}: {
  name: string
  image?: string | null
  agents: readonly AgentProfile[]
  collection: boolean
  statuses: Record<string, RuntimeStatus>
  selected?: AgentProfile
  locked: boolean
  onAction: (action: WorkspaceAction) => void
  onSelect: (id: AgentProfile["id"]) => void
  onCollection: () => void
  onAgentSettings: (agent: AgentProfile) => void
  onEdit: (agent: AgentProfile) => void
  onArchive: (agent: AgentProfile) => void
}) {
  const { family } = useFamily()
  const searchTrigger = useRef<HTMLButtonElement>(null)
  const { setOpenMobile } = useSidebar()
  const search = useWorkspaceCommand({
    locked: () => locked,
    dispatch: (command) => {
      if (command.kind === "action") onAction(command.id)
      else {
        setOpenMobile(false)
        onSelect(command.id)
      }
    },
    listen: (toggle, opened, unlocked) => {
      const shortcut = (event: KeyboardEvent) => {
        if (
          event.key.toLowerCase() !== "k" ||
          !(event.metaKey || event.ctrlKey) ||
          event.isComposing ||
          event.repeat
        )
          return
        if (!opened() && document.activeElement?.closest('[role="dialog"]'))
          return
        event.preventDefault()
        if (unlocked()) {
          setOpenMobile(false)
          toggle()
        }
      }
      window.addEventListener("keydown", shortcut)
      return () => window.removeEventListener("keydown", shortcut)
    },
  })
  const run = (action: WorkspaceAction) => {
    setOpenMobile(false)
    search.choose({ kind: "action", id: action })
  }
  const commands = [
    { id: "create", label: "New assistant", icon: Plus },
    { id: "settings", label: "Settings", icon: Settings2 },
    ...destinations,
  ] as const
  return (
    <>
      <Sidebar variant="inset" collapsible="icon" className="workspace-sidebar">
        <SidebarHeader className="workspace-sidebar-header">
          <div className="workspace-family-row">
            <div className="workspace-family min-h-9">
              <span className="workspace-family-mark" aria-hidden="true">
                {family.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="workspace-sidebar-label">{family.name}</span>
            </div>
          </div>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="New assistant"
                disabled={locked}
                onClick={() => {
                  setOpenMobile(false)
                  run("create")
                }}
                className="workspace-new-assistant"
              >
                <Plus />
                <span>New assistant</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                ref={searchTrigger}
                tooltip="Search"
                disabled={locked}
                aria-label="Search assistants and commands"
                onClick={() => {
                  setOpenMobile(false)
                  search.change(true)
                }}
              >
                <Search />
                <span>Search</span>
                <kbd className="workspace-sidebar-label ms-auto text-xs text-muted-foreground">
                  ⌘ K
                </kbd>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent className="workspace-sidebar-content">
          <p className="workspace-sidebar-label workspace-sidebar-heading">
            Assistants
          </p>
          <SidebarMenu aria-label="Assistants">
            {agents
              .filter((agent) => agent.status === "active")
              .map((agent) => (
                <AssistantNavigationItem
                  key={agent.id}
                  agent={agent}
                  status={statuses[agent.id]?.state}
                  selected={selected?.id === agent.id}
                  locked={locked}
                  onSelect={onSelect}
                  onSettings={onAgentSettings}
                  onEdit={onEdit}
                  onArchive={onArchive}
                />
              ))}
          </SidebarMenu>
          <SidebarMenu className="mt-4">
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="All assistants"
                isActive={collection}
                disabled={locked}
                onClick={() => {
                  setOpenMobile(false)
                  onCollection()
                }}
              >
                <LayoutGrid />
                <span>All assistants</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarContent>
        <SidebarFooter className="workspace-sidebar-footer">
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={locked}
              render={
                <Button
                  variant="ghost"
                  className="workspace-account"
                  aria-label={`Account menu for ${name}`}
                />
              }
            >
              <UserAvatar name={name} image={image} className="size-6" />
              <span className="workspace-sidebar-label min-w-0 flex-1 truncate text-start">
                {name}
              </span>
              <ChevronDown className="workspace-sidebar-label" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top">
              <DropdownMenuGroup>
                <DropdownMenuLabel>{name}</DropdownMenuLabel>
                <DropdownMenuItem
                  disabled={locked}
                  onClick={() => run("settings")}
                >
                  <Settings2 /> Settings
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={locked}
                  onClick={() => run("sign-out")}
                >
                  <LogOut /> Sign out
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarFooter>
      </Sidebar>
      <Dialog
        open={search.open && !locked}
        onOpenChange={search.change}
        onOpenChangeComplete={(open) => {
          if (!open) search.complete()
        }}
      >
        <DialogContent
          className="workspace-command"
          showCloseButton={false}
          finalFocus={() =>
            search.skipFocus
              ? false
              : searchTrigger.current?.getClientRects().length
                ? searchTrigger.current
                : true
          }
        >
          <DialogTitle className="sr-only">
            Search assistants and commands
          </DialogTitle>
          <DialogDescription className="sr-only">
            Find an assistant or open a workbench tool. Conversations are
            searchable in each assistant&apos;s memory.
          </DialogDescription>
          <Command loop>
            <CommandInput
              placeholder="Search assistants and commands…"
              aria-label="Search assistants and commands"
            />
            <CommandList>
              <CommandEmpty>No matching assistants or commands.</CommandEmpty>
              <CommandGroup heading="Assistants">
                {agents
                  .filter((agent) => agent.status === "active")
                  .map((agent) => (
                    <CommandItem
                      key={agent.id}
                      value={`agent:${agent.id}`}
                      keywords={[agent.name, agent.instructions]}
                      onSelect={() =>
                        search.choose({ kind: "agent", id: agent.id })
                      }
                    >
                      <AgentAvatar
                        name={agent.id}
                        label={agent.name}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {agent.name}
                      </span>
                      {selected?.id === agent.id && (
                        <span className="text-xs text-muted-foreground">
                          Current
                        </span>
                      )}
                    </CommandItem>
                  ))}
              </CommandGroup>
              <CommandGroup heading="Commands">
                {commands.map((item) => (
                  <CommandItem
                    key={item.id}
                    value={`command:${item.id}`}
                    keywords={[item.label]}
                    disabled={
                      locked ||
                      (!selected &&
                        item.id !== "create" &&
                        item.id !== "settings")
                    }
                    onSelect={() => run(item.id)}
                  >
                    <item.icon />
                    {item.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
          <footer className="workspace-command-footer">
            <span>↑ ↓ Navigate</span>
            <span>↵ Open</span>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => search.change(false)}
            >
              Esc · Close
            </Button>
          </footer>
        </DialogContent>
      </Dialog>
    </>
  )
}

function AssistantNavigationItem({
  agent,
  status,
  selected,
  locked,
  onSelect,
  onSettings,
  onEdit,
  onArchive,
}: {
  agent: AgentProfile
  status: RuntimeStatus["state"] | undefined
  selected: boolean
  locked: boolean
  onSelect: (id: AgentProfile["id"]) => void
  onSettings: (agent: AgentProfile) => void
  onEdit: (agent: AgentProfile) => void
  onArchive: (agent: AgentProfile) => void
}) {
  const { setOpenMobile } = useSidebar()
  const current = useRef({ locked, onSettings, onEdit, onArchive })
  current.current = { locked, onSettings, onEdit, onArchive }
  const run = (action: "onSettings" | "onEdit" | "onArchive") => {
    if (current.current.locked) return
    setOpenMobile(false)
    current.current[action](agent)
  }
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        tooltip={agent.name}
        isActive={selected}
        aria-disabled={locked}
        aria-label={`${agent.name}, ${agentStatusLabel(status)}`}
        render={
          <Link
            to="/agents/$agentId"
            params={{ agentId: agent.slug }}
            search={{}}
            onClick={(event) => {
              if (locked) {
                event.preventDefault()
                return
              }
              if (
                !event.metaKey &&
                !event.ctrlKey &&
                !event.shiftKey &&
                !event.altKey &&
                event.button === 0
              ) {
                event.preventDefault()
                setOpenMobile(false)
                onSelect(agent.id)
              }
            }}
          />
        }
      >
        <span className="relative -mx-0.5 flex size-5 shrink-0">
          <AgentAvatar
            name={agent.id}
            label={agent.name}
            size={20}
            aria-hidden="true"
          />
          <AgentStatusMarker status={status} />
        </span>
        <span>{agent.name}</span>
      </SidebarMenuButton>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={locked}
          render={
            <SidebarMenuAction
              showOnHover
              aria-label={`Actions for ${agent.name}`}
            />
          }
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{agent.name}</DropdownMenuLabel>
            <DropdownMenuItem
              disabled={locked}
              onClick={() => run("onSettings")}
            >
              <Settings2 /> Assistant settings
            </DropdownMenuItem>
            <DropdownMenuItem disabled={locked} onClick={() => run("onEdit")}>
              <Pencil /> Edit assistant
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={locked || agent.id === homeAgentId}
              variant="destructive"
              onClick={() => run("onArchive")}
            >
              <Archive /> Archive assistant…
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  )
}
