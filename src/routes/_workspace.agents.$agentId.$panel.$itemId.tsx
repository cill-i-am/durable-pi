import { createFileRoute } from "@tanstack/react-router"
import {
  validateWorkspaceSearch,
  workspaceView,
  parseAgentId,
  parsePanel,
  parseResourceId,
} from "@/navigation/workspace"

export const Route = createFileRoute(
  "/_workspace/agents/$agentId/$panel/$itemId"
)({
  params: {
    parse: ({ agentId, panel, itemId }) => ({
      agentId: parseAgentId(agentId),
      panel: parsePanel(panel),
      itemId: parseResourceId(itemId),
    }),
  },
  validateSearch: validateWorkspaceSearch,
  beforeLoad: ({ params, search }) => {
    workspaceView(params, search)
  },
  component: () => null,
})
