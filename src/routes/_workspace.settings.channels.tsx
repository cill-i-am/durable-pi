import { createFileRoute } from "@tanstack/react-router"

import { validateGlobalSettingsSearch } from "@/navigation/workspace"

export const Route = createFileRoute("/_workspace/settings/channels")({
  validateSearch: validateGlobalSettingsSearch,
  head: () => ({ meta: [{ title: "Channels — Pi" }] }),
  component: () => null,
})
