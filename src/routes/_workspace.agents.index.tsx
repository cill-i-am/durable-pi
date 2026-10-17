import { createFileRoute } from "@tanstack/react-router"

import { validateWorkspaceSearch, workspaceView } from "@/navigation/workspace"

export const Route = createFileRoute("/_workspace/agents/")({
  validateSearch: validateWorkspaceSearch,
  beforeLoad: ({ search }) => {
    workspaceView({}, search)
  },
  head: () => ({ meta: [{ title: "Agents — Pi" }] }),
  component: () => null,
})
