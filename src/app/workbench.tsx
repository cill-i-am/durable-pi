import { Link } from "@tanstack/react-router"
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
} from "lucide-react"
import { useState, type ReactNode, type RefObject } from "react"

import { Button, buttonVariants } from "@/components/ui/button"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip"
import { workspaceDestination } from "@/navigation/workspace"

import { useWorkspaceLocation } from "./use-workspace-location"
import type { Workbench } from "./workspace-navigation"

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
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const selected = tools.find((tool) => tool.id === value)!
  return (
    <div
      ref={setContainer}
      className="workbench-host"
      data-open={open}
      inert={!open}
    >
      <Sheet
        // Mount the open Root with its portal host so Base UI skips an initial
        // enter transition instead of replaying it after the loading view.
        key={container ? "host-ready" : "awaiting-host"}
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
                <div className="workbench-tool-picker">
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
                    <SelectTrigger variant="ghost" aria-label="Workbench tool">
                      <selected.icon aria-hidden="true" />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent
                      mobileTitle="Workbench tools"
                      alignItemWithTrigger={false}
                      align="start"
                    >
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
                <nav
                  className="workbench-shortcuts"
                  aria-label="Workbench shortcuts"
                >
                  {tools.slice(0, 5).map((tool) => (
                    <Tooltip key={tool.id}>
                      <TooltipTrigger
                        render={
                          <Link
                            {...workspaceDestination(location.agentId!, {
                              panel: tool.id,
                            })}
                            className={buttonVariants({
                              variant:
                                value === tool.id ? "secondary" : "ghost",
                              size: "icon-sm",
                            })}
                            aria-label={tool.label}
                            aria-current={
                              value === tool.id ? "page" : undefined
                            }
                            aria-disabled={locked || undefined}
                            data-shortcut={tool.id}
                            onClick={(event) => {
                              if (locked) event.preventDefault()
                            }}
                          />
                        }
                      >
                        <tool.icon aria-hidden="true" />
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        {tool.label}
                      </TooltipContent>
                    </Tooltip>
                  ))}
                </nav>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Hide workbench"
                        disabled={locked}
                        onClick={() => onChange(null)}
                      />
                    }
                  >
                    <X />
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Hide workbench</TooltipContent>
                </Tooltip>
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
          </div>
          {mobileNavigation}
        </SheetContent>
        {overlays}
      </Sheet>
    </div>
  )
}
