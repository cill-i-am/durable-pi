import { Link } from "@tanstack/react-router"
import { useWorkspaceLocation } from "./use-workspace-location"
import { workspaceDestination } from "@/navigation/workspace"
import { useState, type ReactNode } from "react"
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
  Ellipsis,
  X,
  ArrowLeft,
} from "lucide-react"
import { AgentMark } from "@/components/agent-mark"
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
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"

const primary = [
  { id: "browser", label: "Browser", icon: Globe },
  { id: "terminal", label: "Terminal", icon: TerminalSquare },
  { id: "files", label: "Files", icon: Files },
  { id: "apps", label: "Apps", icon: PanelsTopLeft },
  { id: "activity", label: "Activity", icon: Activity },
] as const
const more = [
  { id: "objects", label: "Checklists", icon: ListTodo },
  { id: "memory", label: "Memory", icon: BookOpen },
  { id: "code", label: "Code", icon: Code2 },
  { id: "routines", label: "Routines", icon: Clock3 },
] as const

export function WorkbenchPanel({
  value,
  onChange,
  agentName,
  locked,
  overlayOpen,
  mobileNavigation,
  recoveryAction,
  children,
  overlays,
}: {
  value: Workbench
  onChange: (value: Workbench | null) => void
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
  const extra = more.find((tab) => tab.id === value)
  const tabs = extra ? [...primary, extra] : primary
  return (
    <div ref={setContainer} className="workbench-host">
      <Sheet
        open={container !== null}
        desktop="panel"
        breakpoint="lg"
        dismissible={!locked && !overlayOpen}
        modal={!overlayOpen}
        onOpenChange={(open) => {
          if (!open) onChange(null)
        }}
      >
        <SheetContent
          portalContainer={container}
          showOverlay={!overlayOpen}
          mobileLayout="panel"
          showCloseButton={false}
          className="workbench-sheet"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{agentName} workbench</SheetTitle>
            <SheetDescription>
              Private tools, files, activity and saved work for this agent.
            </SheetDescription>
          </SheetHeader>
          <div className="workbench-tabs">
            <div className="workbench-tabbar">
              <div className="mobile-workbench-heading">
                <strong>Workspace</strong>
                <span>
                  <AgentMark />
                  {agentName}
                </span>
              </div>
              <div className="workbench-tab-scroll">
                <nav
                  data-slot="tabs-list"
                  className="group/tabs-list flex h-8 gap-1"
                  data-variant="line"
                  aria-label="Workbench tools"
                >
                  {tabs.map((tab) => (
                    <Link
                      key={tab.id}
                      {...workspaceDestination(location.agentId!, {
                        panel: tab.id,
                      })}
                      data-slot="tabs-trigger"
                      data-active={value === tab.id ? "" : undefined}
                      aria-current={value === tab.id ? "page" : undefined}
                      aria-disabled={locked || undefined}
                      onClick={(event) => {
                        if (locked) event.preventDefault()
                      }}
                      className="relative inline-flex items-center justify-center gap-1.5 px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-disabled:pointer-events-none [&_svg]:size-4"
                    >
                      <tab.icon />
                      {tab.label}
                    </Link>
                  ))}
                </nav>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={locked}
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="More workbench tools"
                    />
                  }
                >
                  <Ellipsis />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuGroup>
                    {more.map((tab) => (
                      <DropdownMenuItem
                        key={tab.id}
                        render={
                          <Link
                            {...workspaceDestination(location.agentId!, {
                              panel: tab.id,
                            })}
                          />
                        }
                      >
                        <tab.icon />
                        {tab.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Hide workbench"
                disabled={locked}
                onClick={() => onChange(null)}
              >
                <X className="workbench-close-icon" />
                <ArrowLeft className="workbench-back-icon" />
              </Button>
            </div>
            <section
              aria-label={`${tabs.find((tab) => tab.id === value)?.label ?? value} workbench`}
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
          {mobileNavigation}
        </SheetContent>
        {overlays}
      </Sheet>
    </div>
  )
}
