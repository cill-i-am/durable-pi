import { createFileRoute, redirect } from "@tanstack/react-router"

import {
  parseAgentReference,
  validateWorkspaceSearch,
} from "@/navigation/workspace"

export const Route = createFileRoute("/_workspace/agents/$agentId/settings/")({
  params: {
    parse: ({ agentId }) => ({ agentId: parseAgentReference(agentId) }),
  },
  validateSearch: validateWorkspaceSearch,
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: "/agents/$agentId/settings/$section",
      params: { ...params, section: "general" },
      search,
      replace: true,
    })
  },
})
