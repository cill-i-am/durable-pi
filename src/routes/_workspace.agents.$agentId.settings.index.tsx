import { createFileRoute } from "@tanstack/react-router"

import {
  parseAgentReference,
  validateWorkspaceSearch,
  workspaceView,
} from "@/navigation/workspace"

export const Route = createFileRoute("/_workspace/agents/$agentId/settings/")({
  params: {
    parse: ({ agentId }) => ({ agentId: parseAgentReference(agentId) }),
  },
  validateSearch: validateWorkspaceSearch,
  beforeLoad: ({ params, search }) => {
    workspaceView({ ...params, section: "agent-settings" }, search)
  },
  head: () => ({ meta: [{ title: "Agent settings — Pi" }] }),
  component: () => null,
})
