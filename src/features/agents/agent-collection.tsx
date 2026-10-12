import { Link } from "@tanstack/react-router"
import { Archive, Plus, Undo2 } from "lucide-react"
import type { AgentProfile } from "@/agents/contracts"
import { AgentMark, agentTone } from "@/components/agent-mark"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export function AgentCollection({
  agents,
  archived,
  query,
  onQuery,
  onCreate,
  onRestore,
}: {
  agents: AgentProfile[]
  archived: boolean
  query: string
  onQuery: (query: string) => void
  onCreate: () => void
  onRestore: (agent: AgentProfile) => void
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
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">
          {archived ? "Archived agents" : "Your agents"}
        </h1>
        {archived ? (
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link to="/agents" />}
          >
            Active agents
          </Button>
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
      <div className="divide-y rounded-lg border">
        {shown.map((agent) => (
          <div key={agent.id} className="flex items-center gap-3 p-4">
            <Link
              to="/agents/$agentId"
              params={{ agentId: agent.id }}
              className="flex min-w-0 flex-1 items-center gap-3 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <AgentMark tone={agentTone(agent.id)} />
              <span className="min-w-0">
                <strong className="block truncate text-sm">{agent.name}</strong>
                <span className="block truncate text-xs text-muted-foreground">
                  {agent.instructions || "Your personal assistant"}
                </span>
              </span>
            </Link>
            {archived && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onRestore(agent)}
                aria-label={`Restore ${agent.name}`}
              >
                <Undo2 />
                Restore
              </Button>
            )}
          </div>
        ))}
        {!shown.length && (
          <p className="p-6 text-sm text-muted-foreground">
            {query
              ? "No matching agents."
              : archived
                ? "No archived agents."
                : "No agents yet."}
          </p>
        )}
      </div>
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
