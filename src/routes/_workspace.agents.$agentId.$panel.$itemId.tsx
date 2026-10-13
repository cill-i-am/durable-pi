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
  head: ({ params }) => ({
    meta: [
      {
        title: `${params.panel === "objects" ? "Checklists" : params.panel.charAt(0).toUpperCase() + params.panel.slice(1)} — Pi`,
      },
    ],
  }),
  component: () => null,
})
