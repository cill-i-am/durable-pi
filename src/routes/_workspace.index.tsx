import { createFileRoute } from "@tanstack/react-router"

import { validateWorkspaceSearch, workspaceView } from "@/navigation/workspace"

export const Route = createFileRoute("/_workspace/")({
  validateSearch: validateWorkspaceSearch,
  beforeLoad: ({ search }) => {
    workspaceView({}, search)
  },
  component: () => null,
})
