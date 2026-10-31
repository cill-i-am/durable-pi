import { Button } from "@workspace/ui/components/button"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@workspace/ui/components/tooltip"
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
  Plus,
  Maximize,
  Minimize,
  ArrowLeft,
} from "lucide-react"
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react"

import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import type { Workbench } from "@/navigation/workspace"

import { useWorkbenchTabs } from "./use-workbench-tabs"

import "./workbench.css"

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

function FrameAction({
  label,
  disabled,
  onClick,
  children,
  className,
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: ReactNode
  className?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            className={className}
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

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
  renderTool,
  onExpandedChange,
}: {
  open: boolean
  value: Workbench
  onChange: (value: Workbench | null) => void
  onClosed: () => void
  returnFocus: RefObject<HTMLElement | null>
  agentName: string
  agentReference: string
  locked: boolean
  overlayOpen: boolean
  mobileNavigation?: ReactNode
  recoveryAction?: ReactNode
  children?: ReactNode
  overlays?: ReactNode
  renderTool?: (panel: Workbench, active: boolean) => ReactNode
  onExpandedChange?: (expanded: boolean) => void
}) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const tabs = useWorkbenchTabs(
    { open, panel: value, locked, overlayOpen },
    onChange
  )
  const disabled = locked || overlayOpen || !tabs.ready
  const selected = tools.find((tool) => tool.id === value)!
  const tablist = useRef<HTMLDivElement>(null)
  const sheetContainer = useRef<HTMLDivElement>(null)
  const mobileTabsTrigger = useRef<HTMLButtonElement>(null)
  const expansionCallback = useRef(onExpandedChange)
  expansionCallback.current = onExpandedChange
  const id = useId()
  useEffect(() => {
    expansionCallback.current?.(tabs.expanded)
  }, [tabs.expanded])
  useEffect(() => () => expansionCallback.current?.(false), [])
  const closeTab = (panel: Workbench, mobile = false) => {
    if (disabled) return
    const index = tabs.tabs.indexOf(panel)
    const remaining = tabs.tabs.filter((item) => item !== panel)
    const next =
      panel === value ? remaining[Math.min(index, remaining.length - 1)] : value
    tabs.close(panel)
    if (!next) return
    if (mobile) mobileTabsTrigger.current?.focus()
    else
      Array.from(
        tablist.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ??
          []
      )
        .find((button) => button.dataset.panel === next)
        ?.focus()
  }
  const keyboard = (
    event: KeyboardEvent<HTMLButtonElement>,
    panel: Workbench
  ) => {
    const index = tabs.tabs.indexOf(panel)
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.tabs.length - 1
          : event.key === "ArrowRight"
            ? (index + 1) % tabs.tabs.length
            : event.key === "ArrowLeft"
              ? (index + tabs.tabs.length - 1) % tabs.tabs.length
              : null
    if (next !== null) {
      event.preventDefault()
      if (disabled) return
      tabs.select(tabs.tabs[next]!)
      tablist.current
        ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
        [next]?.focus()
    } else if (event.key === "Delete") {
      event.preventDefault()
      closeTab(panel)
    }
  }
  const addTool = (
    <DropdownMenu
      open={tabs.toolsOpen}
      onOpenChange={(next) => (next ? tabs.showTools() : tabs.dismiss())}
    >
      <DropdownMenuTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            className="workbench-add-tab"
            aria-label="Open a tool"
            disabled={disabled}
          />
        }
      >
        <Plus aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        portalContainer={sheetContainer}
        mobileTitle="Open a tool"
        align="start"
        className="workbench-add-menu"
      >
        <DropdownMenuGroup>
          {tools.map((tool) => (
            <DropdownMenuItem
              key={tool.id}
              disabled={disabled}
              onClick={() => tabs.select(tool.id)}
            >
              <tool.icon aria-hidden="true" />
              {tool.label}
              {tabs.tabs.includes(tool.id) && (
                <span className="sr-only">, open</span>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
  return (
    <div
      ref={setContainer}
      className="workbench-host"
      data-open={open}
      data-expanded={tabs.expanded}
      inert={!open}
    >
      <Sheet
        key={container ? "host-ready" : "awaiting-host"}
        open={open && container !== null}
        desktop="panel"
        breakpoint="md"
        dismissible={!locked && !overlayOpen}
        modal={!overlayOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) tabs.hide()
        }}
        onOpenChangeComplete={(nextOpen) => {
          if (!nextOpen && !open) onClosed()
        }}
      >
        <SheetContent
          ref={sheetContainer}
          portalContainer={container}
          keepMounted
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
              <div className="workbench-mobile-navigation">
                <FrameAction
                  label="Back to conversation"
                  disabled={disabled}
                  onClick={tabs.hide}
                >
                  <ArrowLeft aria-hidden="true" />
                </FrameAction>
                <span>Workbench</span>
                <FrameAction
                  label="Hide workbench"
                  disabled={disabled}
                  onClick={tabs.hide}
                >
                  <X aria-hidden="true" />
                </FrameAction>
              </div>
              {tabs.expanded && (
                <div className="workbench-expanded-navigation">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    onClick={() => tabs.expand(false)}
                  >
                    <ArrowLeft aria-hidden="true" />
                    Back to conversation
                  </Button>
                  <div className="workbench-frame-actions">
                    <FrameAction
                      label="Collapse workbench"
                      disabled={disabled}
                      onClick={() => tabs.expand(false)}
                    >
                      <Minimize aria-hidden="true" />
                    </FrameAction>
                    <FrameAction
                      label="Hide workbench"
                      disabled={disabled}
                      onClick={tabs.hide}
                    >
                      <X aria-hidden="true" />
                    </FrameAction>
                  </div>
                </div>
              )}
              <header className="workbench-header">
                <div className="workbench-tabs-scroller">
                  <div className="workbench-tabs-layout">
                    <div
                      ref={tablist}
                      role="tablist"
                      aria-label="Open workbench tools"
                      className="workbench-tabs"
                    >
                      {tabs.tabs.map((panel) => {
                        const tool = tools.find((item) => item.id === panel)!
                        return (
                          <div
                            key={panel}
                            role="presentation"
                            className="workbench-tab-frame"
                            data-active={panel === value}
                          >
                            <button
                              type="button"
                              id={`${id}-tab-${panel}`}
                              data-panel={panel}
                              role="tab"
                              aria-selected={panel === value}
                              aria-controls={`${id}-panel-${panel}`}
                              tabIndex={panel === value ? 0 : -1}
                              disabled={disabled}
                              className="workbench-tab"
                              onClick={() => tabs.select(panel)}
                              onKeyDown={(event) => keyboard(event, panel)}
                            >
                              {tool.label}
                            </button>
                          </div>
                        )
                      })}
                    </div>
                    <div className="workbench-tab-close-controls">
                      {tabs.tabs.map((panel) => (
                        <div key={panel} className="workbench-close-tab-slot">
                          <button
                            type="button"
                            className="workbench-close-tab"
                            aria-label={`Close ${tools.find((tool) => tool.id === panel)!.label} tab`}
                            disabled={disabled}
                            onClick={() => closeTab(panel)}
                          >
                            <X aria-hidden="true" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="workbench-current-tab">
                  <span>{selected.label}</span>
                  <button
                    type="button"
                    className="workbench-close-tab"
                    aria-label={`Close ${selected.label} tab`}
                    disabled={disabled}
                    onClick={() => closeTab(value, true)}
                  >
                    <X aria-hidden="true" />
                  </button>
                </div>
                <Button
                  ref={mobileTabsTrigger}
                  size="icon-sm"
                  variant="ghost"
                  className="workbench-open-tabs"
                  aria-label={`Open tabs (${tabs.tabs.length})`}
                  disabled={disabled}
                  onClick={tabs.showTabs}
                >
                  <span>{tabs.tabs.length}</span>
                </Button>
                {addTool}
                {!tabs.expanded && (
                  <div className="workbench-frame-actions workbench-desktop-actions">
                    <FrameAction
                      label="Expand workbench"
                      disabled={disabled}
                      onClick={() => tabs.expand(true)}
                    >
                      <Maximize aria-hidden="true" />
                    </FrameAction>
                    <FrameAction
                      label="Hide workbench"
                      disabled={disabled}
                      onClick={tabs.hide}
                    >
                      <X aria-hidden="true" />
                    </FrameAction>
                  </div>
                )}
              </header>
              {recoveryAction && (
                <div role="status" className="workbench-recovery">
                  <span>An earlier checklist save needs recovery.</span>
                  {recoveryAction}
                </div>
              )}
              {(renderTool ? tabs.tabs : [value]).map((panel) => (
                <section
                  key={panel}
                  id={`${id}-panel-${panel}`}
                  role="tabpanel"
                  aria-labelledby={`${id}-tab-${panel}`}
                  aria-label={`${tools.find((tool) => tool.id === panel)!.label} workbench`}
                  className="workbench-panel workbench-tool-panel"
                  hidden={panel !== value}
                  inert={
                    !open ||
                    panel !== value ||
                    overlayOpen ||
                    Boolean(recoveryAction)
                  }
                >
                  <div className="contents">
                    {renderTool
                      ? renderTool(
                          panel,
                          open && panel === value && !overlayOpen
                        )
                      : children}
                  </div>
                </section>
              ))}
            </div>
          </div>
          {mobileNavigation}
          <Sheet
            open={tabs.tabsOpen && open && !overlayOpen}
            onOpenChange={(next) => {
              if (!next) tabs.dismiss()
            }}
          >
            <SheetContent
              side="bottom"
              className="workbench-open-tabs-sheet"
              showCloseButton={false}
              finalFocus={mobileTabsTrigger}
            >
              <SheetHeader className="workbench-open-tabs-heading">
                <SheetTitle>Open tabs</SheetTitle>
                <SheetDescription className="sr-only">
                  Choose or close an open workbench tool.
                </SheetDescription>
                <FrameAction
                  label="Open another tool"
                  disabled={disabled}
                  onClick={tabs.showTools}
                >
                  <Plus aria-hidden="true" />
                </FrameAction>
                <FrameAction
                  label="Close open tabs"
                  disabled={false}
                  onClick={tabs.dismiss}
                >
                  <X aria-hidden="true" />
                </FrameAction>
              </SheetHeader>
              <div className="workbench-open-tabs-list">
                {tabs.tabs.map((panel) => {
                  const tool = tools.find((item) => item.id === panel)!
                  return (
                    <div
                      key={panel}
                      className="workbench-open-tab-row"
                      data-active={panel === value}
                    >
                      <button
                        type="button"
                        disabled={disabled}
                        aria-current={panel === value ? "page" : undefined}
                        onClick={() => tabs.select(panel)}
                      >
                        <tool.icon aria-hidden="true" />
                        <span>{tool.label}</span>
                      </button>
                      <button
                        type="button"
                        className="workbench-close-tab"
                        aria-label={`Close ${tool.label} tab`}
                        disabled={disabled}
                        onClick={() => closeTab(panel, true)}
                      >
                        <X aria-hidden="true" />
                      </button>
                    </div>
                  )
                })}
              </div>
            </SheetContent>
          </Sheet>
        </SheetContent>
        {overlays}
      </Sheet>
    </div>
  )
}
