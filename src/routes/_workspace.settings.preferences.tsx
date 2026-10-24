import { createFileRoute } from "@tanstack/react-router"

import { validateGlobalSettingsSearch } from "@/navigation/workspace"

export const Route = createFileRoute("/_workspace/settings/preferences")({
  validateSearch: validateGlobalSettingsSearch,
  head: () => ({ meta: [{ title: "Preferences — Pi" }] }),
  component: () => null,
})
