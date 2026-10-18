import { createFileRoute } from "@tanstack/react-router"

import {
  validateWorkspaceSearch,
  workspaceView,
  parseAgentReference,
  parsePanel,
} from "@/navigation/workspace"

export const Route = createFileRoute("/_workspace/agents/$agentId/$panel/")({
  params: {
    parse: ({ agentId, panel }) => ({
      agentId: parseAgentReference(agentId),
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
