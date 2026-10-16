import { Sparkles, MessageSquare, PanelsTopLeft } from "lucide-react"

import { Button } from "@/components/ui/button"

export function MobileNavigation({
  workspace,
  locked,
  workspaceDisabled = locked,
  onAgents,
  onChat,
  onWorkspace,
}: {
  workspace: boolean
  locked: boolean
  workspaceDisabled?: boolean
  onAgents: () => void
  onChat: () => void
  onWorkspace: () => void
}) {
  return (
    <nav className="mobile-navigation" aria-label="Mobile workspace">
      <Button variant="ghost" disabled={locked} onClick={onAgents}>
        <Sparkles />
        <span>Agents</span>
      </Button>
      <Button
        variant="ghost"
        disabled={locked}
        aria-current={!workspace ? "page" : undefined}
        onClick={onChat}
      >
        <MessageSquare />
        <span>Chat</span>
      </Button>
      <Button
        variant="ghost"
        disabled={workspaceDisabled}
        aria-current={workspace ? "page" : undefined}
        onClick={onWorkspace}
      >
        <PanelsTopLeft />
        <span>Workspace</span>
      </Button>
    </nav>
  )
}
