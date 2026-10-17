import {
  Activity,
  Archive,
  BookOpen,
  ChevronDown,
  Clock3,
  Code2,
  Globe,
  Files,
  ListTodo,
  LogOut,
  PanelLeft,
  PanelRight,
  PanelsTopLeft,
  Plus,
  Search,
  ShieldCheck,
  Settings2,
  TerminalSquare,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"

import type { AgentProfile } from "@/agents/contracts"
import { homeAgentId } from "@/agents/contracts"
import { AgentMark, agentTone } from "@/components/agent-mark"
import { Button } from "@/components/ui/button"
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
  Menubar,
  MenubarMenu,
  MenubarTrigger,
  MenubarContent,
  MenubarGroup,
  MenubarItem,
  MenubarSeparator,
} from "@/components/ui/menubar"
import { useSidebar } from "@/components/ui/sidebar"
import { UserAvatar } from "@/components/user-avatar"
import type { Workbench } from "@/navigation/workspace"

export type { Workbench } from "@/navigation/workspace"
export type WorkspaceAction =
  | Workbench
  | "create"
  | "edit"
  | "archive"
  | "memory"
  | "hide-workbench"
  | "sign-out"
  | "security"
  | "settings"

const destinations = [
  { id: "activity", label: "Activity", icon: Activity },
  { id: "objects", label: "Checklists", icon: ListTodo },
  { id: "files", label: "Files", icon: Files },
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
  selected,
  locked,
  workbench,
  onAction,
  onSelect,
}: {
  name: string
  image?: string | null
  agents: readonly AgentProfile[]
  selected?: AgentProfile
  locked: boolean
  workbench: Workbench | null
  onAction: (action: WorkspaceAction) => void
  onSelect: (id: AgentProfile["id"]) => void
}) {
  const [searchOpen, setSearchOpen] = useState(false)
  const searchTrigger = useRef<HTMLButtonElement>(null)
  const skipSearchFocusReturn = useRef(false)
  const afterSearch = useRef<
    | { kind: "action"; id: WorkspaceAction }
    | { kind: "agent"; id: AgentProfile["id"] }
    | null
  >(null)
  const { toggleSidebar, setOpenMobile } = useSidebar()
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (
        event.key.toLowerCase() !== "k" ||
        !(event.metaKey || event.ctrlKey) ||
        event.isComposing ||
        event.repeat
      )
        return
      if (!searchOpen && document.activeElement?.closest('[role="dialog"]'))
        return
      event.preventDefault()
      if (!locked) {
        setOpenMobile(false)
        setSearchOpen((value) => !value)
      }
    }
    window.addEventListener("keydown", shortcut)
    return () => window.removeEventListener("keydown", shortcut)
  }, [locked, searchOpen, setOpenMobile])
  function run(action: WorkspaceAction) {
    if (locked) return
    if (searchOpen) {
      skipSearchFocusReturn.current = true
      afterSearch.current = { kind: "action", id: action }
      setSearchOpen(false)
    } else onAction(action)
  }
  const commands = [
    { id: "security", label: "Account security", icon: ShieldCheck },
    { id: "create", label: "New agent", icon: Plus },
    { id: "settings", label: "Settings", icon: Settings2 },
    { id: "memory", label: "Search this agent's memory", icon: BookOpen },
    ...destinations,
  ] as const
  return (
    <>
      <header className="workspace-bar">
        <div className="workspace-brand">
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={locked}
              render={
                <Button variant="ghost" className="workspace-brand-button" />
              }
            >
              <UserAvatar name={name} image={image} />
              <strong>Pi</strong>
              <span>/ Personal</span>
              <ChevronDown />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-68">
              <DropdownMenuGroup>
                <DropdownMenuLabel className="flex items-center gap-3 py-3">
                  <UserAvatar name={name} image={image} />
                  <span>
                    Personal workspace
                    <span className="block text-xs font-normal text-muted-foreground">
                      {name} · private
                    </span>
                  </span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={locked}
                  onClick={() => run("create")}
                >
                  <Plus />
                  New agent
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={locked}
                  onClick={() => setSearchOpen(true)}
                >
                  <Search />
                  Search agents and commands
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={locked || !selected}
                  onClick={() => run("settings")}
                >
                  <Settings2 />
                  Settings
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={locked}
                  onClick={() => run("sign-out")}
                >
                  <LogOut />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Menubar className="workspace-menubar" aria-label="Workspace commands">
          <MenubarMenu>
            <MenubarTrigger disabled={locked}>Agent</MenubarTrigger>
            <MenubarContent>
              <MenubarGroup>
                <MenubarItem disabled={locked} onClick={() => run("create")}>
                  <Plus />
                  New agent
                </MenubarItem>
                <MenubarItem
                  disabled={locked || !selected}
                  onClick={() => run("settings")}
                >
                  <Settings2 />
                  Settings
                </MenubarItem>
                <MenubarItem
                  disabled={locked || !selected}
                  onClick={() => run("memory")}
                >
                  <BookOpen />
                  Memory
                </MenubarItem>
                <MenubarSeparator />
                <MenubarItem
                  disabled={locked || !selected || selected.id === homeAgentId}
                  onClick={() => run("archive")}
                >
                  <Archive />
                  Archive agent
                </MenubarItem>
              </MenubarGroup>
            </MenubarContent>
          </MenubarMenu>
          <MenubarMenu>
            <MenubarTrigger disabled={locked}>View</MenubarTrigger>
            <MenubarContent>
              <MenubarGroup>
                <MenubarItem onClick={toggleSidebar}>
                  <PanelLeft />
                  Toggle sidebar
                  <span className="ml-auto text-xs text-muted-foreground">
                    ⌘ B
                  </span>
                </MenubarItem>
                {destinations.slice(0, 3).map((item) => (
                  <MenubarItem
                    key={item.id}
                    disabled={locked || !selected}
                    onClick={() => run(item.id)}
                  >
                    <item.icon />
                    {item.label}
                  </MenubarItem>
                ))}
                <MenubarItem
                  disabled={locked || !workbench}
                  onClick={() => run("hide-workbench")}
                >
                  <PanelRight />
                  Hide workbench
                </MenubarItem>
              </MenubarGroup>
            </MenubarContent>
          </MenubarMenu>
          <MenubarMenu>
            <MenubarTrigger disabled={locked}>Tools</MenubarTrigger>
            <MenubarContent>
              <MenubarGroup>
                {destinations.slice(3).map((item) => (
                  <MenubarItem
                    key={item.id}
                    disabled={locked || !selected}
                    onClick={() => run(item.id)}
                  >
                    <item.icon />
                    {item.label}
                  </MenubarItem>
                ))}
              </MenubarGroup>
            </MenubarContent>
          </MenubarMenu>
        </Menubar>
        <Button
          ref={searchTrigger}
          variant="outline"
          disabled={locked}
          className="workspace-search"
          onClick={() => setSearchOpen(true)}
          aria-label="Search agents and commands"
        >
          <Search />
          <span>Search agents and commands</span>
          <kbd>⌘ K</kbd>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="workspace-sidebar-toggle"
          aria-label="Toggle sidebar"
          onClick={toggleSidebar}
        >
          <PanelLeft />
        </Button>
      </header>
      <Dialog
        open={searchOpen && !locked}
        onOpenChange={setSearchOpen}
        onOpenChangeComplete={(open) => {
          if (open) {
            skipSearchFocusReturn.current = false
            return
          }
          const pending = afterSearch.current
          afterSearch.current = null
          if (!pending || locked) return
          if (pending.kind === "action") onAction(pending.id)
          else {
            setOpenMobile(false)
            onSelect(pending.id)
          }
        }}
      >
        <DialogContent
          className="workspace-command"
          showCloseButton={false}
          finalFocus={() =>
            skipSearchFocusReturn.current
              ? false
              : searchTrigger.current?.getClientRects().length
                ? searchTrigger.current
                : true
          }
        >
          <DialogTitle className="sr-only">
            Search agents and commands
          </DialogTitle>
          <DialogDescription className="sr-only">
            Find an active agent or open a workspace tool. Conversations are
            searchable in each agent&apos;s memory.
          </DialogDescription>
          <Command loop>
            <CommandInput
              placeholder="Search agents and commands…"
              aria-label="Search agents and commands"
            />
            <CommandList>
              <CommandEmpty>No matching agents or commands.</CommandEmpty>
              <CommandGroup heading="Your agents">
                {agents
                  .filter((agent) => agent.status === "active")
                  .map((agent) => (
                    <CommandItem
                      key={agent.id}
                      value={`agent:${agent.id}`}
                      keywords={[agent.name, agent.instructions]}
                      onSelect={() => {
                        if (!locked) {
                          skipSearchFocusReturn.current = true
                          afterSearch.current = { kind: "agent", id: agent.id }
                          setSearchOpen(false)
                        }
                      }}
                    >
                      <AgentMark tone={agentTone(agent.id)} />
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
                        item.id !== "security")
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
              onClick={() => setSearchOpen(false)}
            >
              Esc · Close
            </Button>
          </footer>
        </DialogContent>
      </Dialog>
    </>
  )
}
