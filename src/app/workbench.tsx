import { useEffect, useRef, useState, type ReactNode } from "react"
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
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
  { id: "objects", label: "Objects", icon: ListTodo },
  { id: "memory", label: "Memory", icon: BookOpen },
  { id: "code", label: "Code", icon: Code2 },
  { id: "routines", label: "Routines", icon: Clock3 },
] as const

export function WorkbenchPanel({
  value,
  onChange,
  agentName,
  locked,
  settingsOpen,
  mobileNavigation,
  recoveryAction,
  children,
}: {
  value: Workbench
  onChange: (value: Workbench | null) => void
  agentName: string
  locked: boolean
  settingsOpen: boolean
  mobileNavigation: ReactNode
  recoveryAction?: ReactNode
  children: ReactNode
}) {
  const container = useRef<HTMLDivElement>(null)
  const [wide, setWide] = useState(false)
  useEffect(() => {
    const media = matchMedia("(min-width: 1024px)")
    const update = () => setWide(media.matches)
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])
  const extra = more.find((tab) => tab.id === value)
  const tabs = extra ? [...primary, extra] : primary
  return (
    <div ref={container} className="workbench-host" data-wide={wide}>
      <Sheet
        open
        modal={!wide && !settingsOpen}
        onOpenChange={(open, event) => {
          if (
            !open &&
            !locked &&
            !settingsOpen &&
            (!wide || event.reason === "escape-key")
          )
            onChange(null)
        }}
      >
        <SheetContent
          portalContainer={container}
          showOverlay={!wide && !settingsOpen}
          showCloseButton={false}
          className="workbench-sheet"
          data-wide={wide}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{agentName} workbench</SheetTitle>
            <SheetDescription>
              Private tools, files, activity and saved work for this agent.
            </SheetDescription>
          </SheetHeader>
          <Tabs
            value={value}
            onValueChange={(next) => {
              if (!locked) onChange(next as Workbench)
            }}
            className="workbench-tabs"
          >
            <div className="workbench-tabbar">
              <div className="mobile-workbench-heading">
                <strong>Workspace</strong>
                <span>
                  <AgentMark />
                  {agentName}
                </span>
              </div>
              <div className="workbench-tab-scroll">
                <TabsList variant="line" aria-label="Workbench tools">
                  {tabs.map((tab) => (
                    <TabsTrigger key={tab.id} value={tab.id} disabled={locked}>
                      <tab.icon />
                      {tab.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
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
                        onClick={() => onChange(tab.id)}
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
            <TabsContent value={value} className="workbench-panel">
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
            </TabsContent>
          </Tabs>
          {mobileNavigation}
        </SheetContent>
      </Sheet>
    </div>
  )
}
