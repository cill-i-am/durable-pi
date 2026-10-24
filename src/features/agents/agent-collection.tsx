import { Link } from "@tanstack/react-router"
import { Archive, ArrowLeft, Plus, Settings2, Undo2 } from "lucide-react"

import type { AgentProfile } from "@/agents/contracts"
import { homeAgentId } from "@/agents/contracts"
import { AgentMark, agentTone } from "@/components/agent-mark"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export function AgentCollection({
  agents,
  archived,
  query,
  onQuery,
  onCreate,
  onArchive,
}: {
  agents: AgentProfile[]
  archived: boolean
  query: string
  onQuery: (query: string) => void
  onCreate: () => void
  onArchive: (agent: AgentProfile) => void
}) {
  const shown = agents.filter(
    (agent) =>
      (agent.status === "archived") === archived &&
      agent.name.toLowerCase().includes(query.toLowerCase())
  )
  return (
    <section
      className="mx-auto flex w-full max-w-3xl flex-col gap-6 overflow-y-auto p-6 sm:p-10"
      aria-label={archived ? "Archived agents" : "Your agents"}
    >
      <div className="flex items-center justify-between">
        <Link
          to="/agents/$agentId"
          params={{
            agentId:
              agents.find((agent) => agent.id === homeAgentId)?.slug ??
              homeAgentId,
          }}
          className={buttonVariants({
            variant: "ghost",
            className: "self-start",
          })}
        >
          <ArrowLeft data-icon="inline-start" />
          Back to Home
        </Link>
        <Link
          to="/settings"
          aria-label="Settings"
          className={buttonVariants({ variant: "ghost", size: "icon" })}
        >
          <Settings2 />
        </Link>
      </div>
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">
          {archived ? "Archived agents" : "Your agents"}
        </h1>
        {archived ? (
          <Link
            to="/agents"
            data-slot="button"
            className={buttonVariants({ variant: "outline" })}
          >
            Active agents
          </Link>
        ) : (
          <Button onClick={onCreate}>
            <Plus />
            New agent
          </Button>
        )}
      </header>
      <Input
        aria-label="Filter agents"
        placeholder="Filter agents…"
        maxLength={200}
        value={query}
        onChange={(event) => onQuery(event.target.value)}
      />
      <ul className="divide-y rounded-lg border">
        {shown.map((agent) => (
          <li key={agent.id} className="flex items-center gap-3 p-4">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <AgentMark tone={agentTone(agent.id)} />
              <span className="min-w-0">
                {archived ? (
                  <strong className="block truncate text-sm">
                    {agent.name}
                  </strong>
                ) : (
                  <Link
                    to="/agents/$agentId"
                    params={{ agentId: agent.slug }}
                    className="block truncate rounded-sm text-sm font-semibold outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {agent.name}
                  </Link>
                )}
                <span className="block truncate text-xs text-muted-foreground">
                  {agent.instructions || "Your personal assistant"}
                </span>
              </span>
            </div>
            {agent.id !== homeAgentId && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onArchive(agent)}
                aria-label={`${archived ? "Restore" : "Archive"} ${agent.name}`}
              >
                {archived ? (
                  <Undo2 data-icon="inline-start" />
                ) : (
                  <Archive data-icon="inline-start" />
                )}
                {archived ? "Restore" : "Archive"}
              </Button>
            )}
          </li>
        ))}
        {!shown.length && (
          <li className="p-6 text-sm text-muted-foreground">
            {query
              ? "No matching agents."
              : archived
                ? "No archived agents."
                : "No agents yet."}
          </li>
        )}
      </ul>
      {!archived && (
        <Link
          to="/agents/archived"
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <Archive className="size-4" />
          Archived agents
        </Link>
      )}
    </section>
  )
}
