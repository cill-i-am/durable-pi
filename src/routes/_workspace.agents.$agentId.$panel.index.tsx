import { createFileRoute } from "@tanstack/react-router"

import {
  validateWorkspaceSearch,
  workspaceView,
  parseAgentId,
  parsePanel,
} from "@/navigation/workspace"

export const Route = createFileRoute("/_workspace/agents/$agentId/$panel/")({
  params: {
    parse: ({ agentId, panel }) => ({
      agentId: parseAgentId(agentId),
      panel: parsePanel(panel),
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
