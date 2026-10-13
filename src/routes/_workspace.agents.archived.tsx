import { createFileRoute } from "@tanstack/react-router"
import { validateWorkspaceSearch, workspaceView } from "@/navigation/workspace"

export const Route = createFileRoute("/_workspace/agents/archived")({
  validateSearch: validateWorkspaceSearch,
  beforeLoad: ({ search }) => {
    workspaceView({}, search)
  },
  head: () => ({ meta: [{ title: "Archived agents — Pi" }] }),
  component: () => null,
})
