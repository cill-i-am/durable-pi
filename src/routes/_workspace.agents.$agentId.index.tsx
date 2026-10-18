import { createFileRoute } from "@tanstack/react-router"

import {
  validateWorkspaceSearch,
  workspaceView,
  parseAgentReference,
} from "@/navigation/workspace"

export const Route = createFileRoute("/_workspace/agents/$agentId/")({
  params: {
    parse: ({ agentId }) => ({ agentId: parseAgentReference(agentId) }),
  },
  validateSearch: validateWorkspaceSearch,
  beforeLoad: ({ params, search }) => {
    workspaceView(params, search)
  },
  component: () => null,
})
