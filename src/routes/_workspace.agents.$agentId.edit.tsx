import { createFileRoute } from "@tanstack/react-router"

import { validateAuthSearch, parseAgentReference } from "@/navigation/workspace"

export const Route = createFileRoute("/_workspace/agents/$agentId/edit")({
  params: {
    parse: ({ agentId }) => ({ agentId: parseAgentReference(agentId) }),
  },
  validateSearch: validateAuthSearch,
  head: () => ({ meta: [{ title: "Edit agent — Pi" }] }),
  component: () => null,
})
