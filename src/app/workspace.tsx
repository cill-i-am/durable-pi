import { useState } from "react"
import {
  Globe,
  Code2,
  PanelsTopLeft,
  PanelRight,
  TerminalSquare,
} from "lucide-react"
import { TerminalWorkbench } from "@/features/terminal"
import { AppsWorkbench } from "@/features/apps"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import { ExecutionWorkbench } from "@/features/execution"
import { BrowserWorkbench } from "@/features/browser"
import { authClient } from "@/auth/client"
import { Login, PiMark } from "@/features/auth"
import { Conversation } from "@/features/conversation"
import { AgentEditor, AgentSidebar, useAgentCatalog } from "@/features/agents"
import type { AgentProfile } from "@/agents/contracts"
import { api } from "@/http/client"
import { SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"

export function ChatApp() {
  const { data: session, isPending, error } = authClient.useSession()
  if (isPending)
    return (
      <main className="loading-view">
        <PiMark />
        <Skeleton className="h-4 w-40" />
        <span className="sr-only">Loading your session</span>
      </main>
    )
  if (!session) return <Login sessionError={error?.message} />
  return (
    <Workspace
      key={session.user.id}
      ownerId={session.user.id}
      name={session.user.name}
    />
  )
}
function Workspace({ ownerId, name }: { ownerId: string; name: string }) {
  const catalog = useAgentCatalog(ownerId)
  const [editor, setEditor] = useState<{
    agent?: AgentProfile
    key: string
  } | null>(null)
  const [error, setError] = useState("")
  async function archive(agent: AgentProfile) {
    try {
      await api("/api/agent/bots/archive", {
        id: agent.id,
        archived: agent.status === "active",
      })
      await catalog.refresh()
      setError("")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not archive this agent.")
    }
  }
  return (
    <TooltipProvider>
      <SidebarProvider className="workspace-shell">
        <AgentSidebar
          agents={catalog.agents}
          selected={catalog.selected}
          name={name}
          onSelect={catalog.select}
          onCreate={() => setEditor({ key: crypto.randomUUID() })}
          onEdit={(agent) => setEditor({ key: agent.id, agent })}
          onArchive={(agent) => void archive(agent)}
        />
        <main className="workspace-main">
          {(error || catalog.error) && (
            <Alert>
              <AlertDescription className="flex items-center justify-between">
                {error || catalog.error}
                <Button
                  variant="ghost"
                  onClick={() =>
                    void catalog
                      .refresh()
                      .then(() => setError(""))
                      .catch(() => setError("Could not reconnect. Try again."))
                  }
                >
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {catalog.selected ? (
            <AgentWorkspace
              key={catalog.selected.id}
              name={name}
              agent={catalog.selected}
            />
          ) : (
            <div className="loading-view">
              <Skeleton className="h-6 w-44" />
              <p className="text-sm text-muted-foreground">
                {catalog.loading
                  ? "Opening your workspace…"
                  : "Your workspace is unavailable."}
              </p>
            </div>
          )}
        </main>
        {editor && (
          <AgentEditor
            key={editor.key}
            open
            agent={editor.agent}
            onOpenChange={(open) => {
              if (!open) setEditor(null)
            }}
            onSaved={async (agent) => {
              await catalog.refresh()
              catalog.select(agent.id)
            }}
          />
        )}
      </SidebarProvider>
    </TooltipProvider>
  )
}

function AgentWorkspace({
  agent,
  name,
}: {
  agent: AgentProfile
  name: string
}) {
  const [workbench, setWorkbench] = useState<
    "browser" | "code" | "apps" | "terminal" | null
  >(null)
  const browserOpen = workbench === "browser"
  return (
    <div className={`agent-columns ${workbench ? "workbench-visible" : ""}`}>
      <Conversation
        name={name}
        agent={agent}
        workbenchAction={
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  size="sm"
                  variant={workbench ? "secondary" : "ghost"}
                  aria-label="Open workbench"
                />
              }
            >
              <PanelRight data-icon="inline-start" />
              <span className="hidden sm:inline">Workbench</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={() => setWorkbench("browser")}>
                  <Globe /> Browser
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setWorkbench("code")}>
                  <Code2 /> Code
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setWorkbench("apps")}>
                  <PanelsTopLeft /> Apps
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setWorkbench("terminal")}>
                  <TerminalSquare /> Terminal
                </DropdownMenuItem>
                {workbench && (
                  <DropdownMenuItem onClick={() => setWorkbench(null)}>
                    Hide workbench
                  </DropdownMenuItem>
                )}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />
      {workbench === "terminal" && (
        <TerminalWorkbench
          agentId={agent.id}
          agentName={agent.name}
          onClose={() => setWorkbench(null)}
        />
      )}
      {workbench === "apps" && (
        <AppsWorkbench
          agentId={agent.id}
          agentName={agent.name}
          onClose={() => setWorkbench(null)}
        />
      )}
      {workbench === "code" && (
        <ExecutionWorkbench
          agentId={agent.id}
          agentName={agent.name}
          onClose={() => setWorkbench(null)}
        />
      )}
      {browserOpen && (
        <BrowserWorkbench
          agentId={agent.id}
          agentName={agent.name}
          onClose={() => setWorkbench(null)}
        />
      )}
    </div>
  )
}
