import { AgentAvatar } from "@workspace/ui/components/agent-avatar"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@workspace/ui/components/dialog"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { useState, type ReactNode } from "react"

import type { AgentProfile } from "@/agents/contracts"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { SidebarTrigger } from "@/components/ui/sidebar"

export function ChatHeader({
  agent,
  name,
  userImage,
  workbenchAction,
}: {
  agent: AgentProfile
  name: string
  userImage?: string | null
  workbenchAction?: ReactNode
}) {
  const [hoveredName, setHoveredName] = useState<string | null>(null)
  return (
    <header className="chat-header">
      <div className="chat-identity">
        <SidebarTrigger />
        <h1 title={agent.name}>{agent.name}</h1>
        {agent.status === "archived" && (
          <Badge variant="secondary">Archived</Badge>
        )}
      </div>
      <div className="chat-header-actions">
        <Dialog>
          <TooltipProvider>
            <Tooltip>
              <DialogTrigger
                render={
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        className="conversation-people-trigger"
                        aria-label="People in this chat"
                        aria-description={`${name}, ${agent.name}`}
                        onPointerLeave={() => setHoveredName(null)}
                        onFocus={() => setHoveredName(null)}
                      />
                    }
                  />
                }
              >
                <span
                  className="conversation-person-avatar"
                  onPointerEnter={() => setHoveredName(name)}
                >
                  <PersonAvatar name={name} image={userImage} />
                </span>
                <span
                  className="conversation-person-avatar"
                  onPointerEnter={() => setHoveredName(agent.name)}
                >
                  <AgentAvatar
                    name={agent.id}
                    label={agent.name}
                    size={32}
                    aria-hidden="true"
                  />
                </span>
              </DialogTrigger>
              <TooltipContent side="bottom">
                {hoveredName ?? `${name}, ${agent.name}`}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <DialogContent className="conversation-people-sheet">
            <DialogHeader>
              <DialogTitle>People in this chat</DialogTitle>
              <DialogDescription className="sr-only">
                This private conversation is between you and {agent.name}.
              </DialogDescription>
            </DialogHeader>
            <ul className="conversation-people-list">
              <li>
                <PersonAvatar name={name} image={userImage} />
                <span className="conversation-person-name">{name}</span>
                <Badge variant="secondary">You</Badge>
              </li>
              <li>
                <AgentAvatar
                  name={agent.id}
                  label={agent.name}
                  size={32}
                  aria-hidden="true"
                />
                <span className="conversation-person-name">{agent.name}</span>
                <Badge variant="secondary">Assistant</Badge>
              </li>
            </ul>
          </DialogContent>
        </Dialog>
        {workbenchAction}
      </div>
    </header>
  )
}

function PersonAvatar({
  name,
  image,
}: {
  name: string
  image?: string | null
}) {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => Array.from(part)[0])
    .join("")
  return (
    <Avatar aria-hidden="true">
      {image && <AvatarImage src={image} alt="" />}
      <AvatarFallback>{initials || "You"}</AvatarFallback>
    </Avatar>
  )
}
