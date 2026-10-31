import { Link } from "@tanstack/react-router"
import { AgentAvatar } from "@workspace/ui/components/agent-avatar"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Archive, Pencil, Plus, Search, Undo2 } from "lucide-react"

import type { AgentProfile } from "@/agents/contracts"
import { homeAgentId } from "@/agents/contracts"
import { SidebarTrigger } from "@/components/ui/sidebar"

import "./assistant-management.css"

export function AgentCollection({
  agents,
  archived,
  query,
  onQuery,
  onCreate,
  onEdit,
  onArchive,
}: {
  agents: AgentProfile[]
  archived: boolean
  query: string
  onQuery: (query: string) => void
  onCreate: () => void
  onEdit?: (agent: AgentProfile) => void
  onArchive: (agent: AgentProfile) => void
}) {
  const shown = agents.filter(
    (agent) =>
      (agent.status === "archived") === archived &&
      agent.name.toLowerCase().includes(query.toLowerCase())
  )
  return (
    <section
      className="assistant-collection"
      aria-label={archived ? "Archived assistants" : "Assistants"}
    >
      <header className="assistant-collection-header">
        <div className="assistant-collection-title">
          <SidebarTrigger />
          <h1>{archived ? "Archived assistants" : "Assistants"}</h1>
        </div>
        {!archived && (
          <Button onClick={onCreate}>
            <Plus /> New assistant
          </Button>
        )}
      </header>
      <div className="assistant-collection-toolbar">
        <nav
          className="assistant-collection-views"
          aria-label="Assistant lists"
        >
          <Link to="/agents" aria-current={!archived ? "page" : undefined}>
            Active<span className="sr-only"> assistants</span>
          </Link>
          <Link
            to="/agents/archived"
            aria-current={archived ? "page" : undefined}
          >
            Archived<span className="sr-only"> assistants</span>
          </Link>
        </nav>
        <div className="assistant-collection-filter">
          <Search aria-hidden="true" />
          <Input
            aria-label="Filter assistants"
            placeholder="Filter assistants…"
            maxLength={200}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
        </div>
      </div>
      <ul className="assistant-collection-list">
        {shown.map((agent) => (
          <li key={agent.id} className="assistant-collection-row">
            <AgentAvatar
              name={agent.id}
              label={agent.name}
              aria-hidden="true"
            />
            <div className="assistant-collection-copy">
              {archived ? (
                <strong className="assistant-collection-name">
                  {agent.name}
                </strong>
              ) : (
                <Link
                  to="/agents/$agentId"
                  params={{ agentId: agent.slug }}
                  className="assistant-collection-name"
                >
                  {agent.name}
                </Link>
              )}
              <p className="assistant-collection-description">
                {agent.instructions || "Your personal assistant"}
              </p>
            </div>
            <div className="assistant-collection-actions">
              {!archived && onEdit && (
                <Button
                  variant="outline"
                  size="icon-sm"
                  onClick={() => onEdit(agent)}
                  aria-label={`Edit ${agent.name}`}
                  title={`Edit ${agent.name}`}
                >
                  <Pencil />
                </Button>
              )}
              {agent.id !== homeAgentId ? (
                <Button
                  variant={archived ? "outline" : "ghost"}
                  size={archived ? "sm" : "icon-sm"}
                  onClick={() => onArchive(agent)}
                  aria-label={`${archived ? "Restore" : "Archive"} ${agent.name}`}
                  title={`${archived ? "Restore" : "Archive"} ${agent.name}`}
                >
                  {archived ? <Undo2 /> : <Archive />}
                  {archived && "Restore"}
                </Button>
              ) : (
                <span
                  className="assistant-collection-action-space"
                  aria-hidden="true"
                />
              )}
            </div>
          </li>
        ))}
        {!shown.length && (
          <li className="assistant-collection-empty">
            <h2>
              {query
                ? "No matching assistants"
                : archived
                  ? "No archived assistants"
                  : "No assistants yet"}
            </h2>
            <p>
              {query
                ? "Try a different name or clear the filter."
                : archived
                  ? "Assistants you archive will appear here."
                  : "Create an assistant for the work you have in mind."}
            </p>
            {query && (
              <Button variant="outline" onClick={() => onQuery("")}>
                Clear filter
              </Button>
            )}
          </li>
        )}
      </ul>
    </section>
  )
}
