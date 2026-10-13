import { Link } from "@tanstack/react-router"
import { useWorkspaceLocation } from "./use-workspace-location"
import { workspaceDestination } from "@/navigation/workspace"
import { useState, type ReactNode, type RefObject } from "react"
import {
  Globe,
  TerminalSquare,
  Files,
  PanelsTopLeft,
  Activity,
  ListTodo,
  BookOpen,
  Code2,
  Clock3,
  X,
  PanelRightOpen,
  PanelRightClose,
} from "lucide-react"
import type { Workbench } from "./workspace-navigation"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from "@/components/ui/sidebar"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select"

const tools = [
  { id: "browser", label: "Browser", icon: Globe },
  { id: "terminal", label: "Terminal", icon: TerminalSquare },
  { id: "files", label: "Files", icon: Files },
  { id: "apps", label: "Apps", icon: PanelsTopLeft },
  { id: "activity", label: "Activity", icon: Activity },

  { id: "objects", label: "Checklists", icon: ListTodo },
  { id: "memory", label: "Memory", icon: BookOpen },
  { id: "code", label: "Code", icon: Code2 },
  { id: "routines", label: "Routines", icon: Clock3 },
] as const

export function WorkbenchPanel({
  open,
  value,
  onChange,
  onClosed,
  returnFocus,
  agentName,
  locked,
  overlayOpen,
  mobileNavigation,
  recoveryAction,
  children,
  overlays,
}: {
  open: boolean
  value: Workbench
  onChange: (value: Workbench | null) => void
  onClosed: () => void
  returnFocus: RefObject<HTMLElement | null>
  agentName: string
  locked: boolean
  overlayOpen: boolean
  mobileNavigation: ReactNode
  recoveryAction?: ReactNode
  children: ReactNode
  overlays?: ReactNode
}) {
  const location = useWorkspaceLocation()
  // Wait for the dock before opening: Base UI then owns the entry transition
  // and never falls back to portaling the panel into document.body.
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const [expanded, setExpanded] = useState(false)
  const selected = tools.find((tool) => tool.id === value)!
  return (
    <div
      ref={setContainer}
      className="workbench-host"
      data-open={open}
      inert={!open}
    >
      <Sheet
        open={open && container !== null}
        desktop="panel"
        breakpoint="md"
        dismissible={!locked && !overlayOpen}
        modal={!overlayOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) onChange(null)
        }}
        onOpenChangeComplete={(nextOpen) => {
          if (!nextOpen && !open) onClosed()
        }}
      >
        <SheetContent
          portalContainer={container}
          showOverlay={!overlayOpen}
          mobileLayout="panel"
          showCloseButton={false}
          className="workbench-sheet"
          finalFocus={returnFocus}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{agentName} workbench</SheetTitle>
            <SheetDescription>
              Private tools, files, activity and saved work for this agent.
            </SheetDescription>
          </SheetHeader>
          <div className="workbench-frame">
            <div className="workbench-main">
              <header className="workbench-header">
                <span className="workbench-identity">
                  Workbench <span>{agentName}</span>
                </span>
                <div className="workbench-mobile-picker">
                  <Select<Workbench>
                    items={tools.map((tool) => ({
                      value: tool.id,
                      label: tool.label,
                    }))}
                    value={value}
                    disabled={locked}
                    onValueChange={(next) => {
                      if (next && !locked) onChange(next)
                    }}
                  >
                    <SelectTrigger aria-label="Workbench tool">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent mobileTitle="Workbench tools">
                      <SelectGroup>
                        {tools.map((tool) => (
                          <SelectItem key={tool.id} value={tool.id}>
                            <tool.icon aria-hidden="true" />
                            {tool.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Hide workbench"
                  disabled={locked}
                  onClick={() => onChange(null)}
                >
                  <X />
                </Button>
              </header>
              <section
                aria-label={`${selected.label} workbench`}
                className="workbench-panel"
              >
                {recoveryAction && (
                  <div
                    role="status"
                    className="flex flex-wrap items-center gap-3 border-b p-4 text-sm"
                  >
                    <span>An earlier checklist save needs recovery.</span>
                    {recoveryAction}
                  </div>
                )}
                <div className="contents" inert={Boolean(recoveryAction)}>
                  {children}
                </div>
              </section>
            </div>
            <Sidebar
              collapsible="none"
              className="workbench-navigation"
              data-expanded={expanded}
              style={
                {
                  "--sidebar-width": expanded ? "164px" : "52px",
                } as React.CSSProperties
              }
            >
              <SidebarHeader>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={
                    expanded
                      ? "Collapse workbench navigation"
                      : "Expand workbench navigation"
                  }
                  title={
                    expanded
                      ? "Collapse workbench navigation"
                      : "Expand workbench navigation"
                  }
                  onClick={() => setExpanded((current) => !current)}
                >
                  {expanded ? <PanelRightClose /> : <PanelRightOpen />}
                </Button>
              </SidebarHeader>
              <SidebarContent>
                <nav aria-label="Workbench tools">
                  <SidebarMenu>
                    {tools.map((tool) => (
                      <SidebarMenuItem key={tool.id}>
                        <SidebarMenuButton
                          isActive={value === tool.id}
                          render={
                            <Link
                              {...workspaceDestination(location.agentId!, {
                                panel: tool.id,
                              })}
                            />
                          }
                          aria-label={tool.label}
                          title={tool.label}
                          aria-current={value === tool.id ? "page" : undefined}
                          aria-disabled={locked || undefined}
                          onClick={(event) => {
                            if (locked) event.preventDefault()
                          }}
                        >
                          <tool.icon aria-hidden="true" />
                          <span className="workbench-tool-label">
                            {tool.label}
                          </span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </nav>
              </SidebarContent>
            </Sidebar>
          </div>
          {mobileNavigation}
        </SheetContent>
        {overlays}
      </Sheet>
    </div>
  )
}
