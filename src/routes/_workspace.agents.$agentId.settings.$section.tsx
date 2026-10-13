import { createFileRoute } from "@tanstack/react-router"
import {
  validateWorkspaceSearch,
  workspaceView,
  parseAgentId,
  parseSection,
} from "@/navigation/workspace"

export const Route = createFileRoute(
  "/_workspace/agents/$agentId/settings/$section"
)({
  params: {
    parse: ({ agentId, section }) => ({
      agentId: parseAgentId(agentId),
      section: parseSection(section),
    }),
  },
  validateSearch: validateWorkspaceSearch,
  beforeLoad: ({ params, search }) => {
    workspaceView(params, search)
  },
  head: ({ params }) => ({
    meta: [
      {
        title: `${params.section.charAt(0).toUpperCase() + params.section.slice(1)} — Pi`,
      },
    ],
  }),
  component: () => null,
})
