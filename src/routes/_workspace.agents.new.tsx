import { createFileRoute } from "@tanstack/react-router"
import { validateAuthSearch } from "@/navigation/workspace"

export const Route = createFileRoute("/_workspace/agents/new")({
  validateSearch: validateAuthSearch,
  head: () => ({ meta: [{ title: "New agent — Pi" }] }),
  component: () => null,
})
