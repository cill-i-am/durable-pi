import { createFileRoute } from "@tanstack/react-router"

import { validateGlobalSettingsSearch } from "@/navigation/workspace"

export const Route = createFileRoute("/_workspace/family")({
  validateSearch: validateGlobalSettingsSearch,
  head: () => ({ meta: [{ title: "Family — Pi" }] }),
  component: () => null,
})
