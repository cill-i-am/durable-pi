import { createFileRoute } from "@tanstack/react-router"
import { validateAuthSearch, parseAgentId } from "@/navigation/workspace"

export const Route = createFileRoute("/_workspace/agents/$agentId/edit")({
  params: { parse: ({ agentId }) => ({ agentId: parseAgentId(agentId) }) },
  validateSearch: validateAuthSearch,
  component: () => null,
})
