import { createFileRoute } from "@tanstack/react-router"

import { validateGlobalSettingsSearch } from "@/navigation/workspace"

export const Route = createFileRoute("/_workspace/settings/")({
  validateSearch: validateGlobalSettingsSearch,
  head: () => ({ meta: [{ title: "Settings — Pi" }] }),
  component: () => null,
})
