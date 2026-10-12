import { createFileRoute } from "@tanstack/react-router"
import { validateAuthSearch } from "@/navigation/workspace"

export const Route = createFileRoute("/_workspace/agents/new")({
  validateSearch: validateAuthSearch,
  component: () => null,
})
