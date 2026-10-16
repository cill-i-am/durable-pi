import { createFileRoute } from "@tanstack/react-router"

import {
  validateWorkspaceSearch,
  workspaceView,
  parseAgentId,
} from "@/navigation/workspace"

export const Route = createFileRoute("/_workspace/agents/$agentId/")({
  params: { parse: ({ agentId }) => ({ agentId: parseAgentId(agentId) }) },
  validateSearch: validateWorkspaceSearch,
  beforeLoad: ({ params, search }) => {
    workspaceView(params, search)
  },
  component: () => null,
})
