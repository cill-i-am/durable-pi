import { createFileRoute } from "@tanstack/react-router"

import { validateGlobalSettingsSearch } from "@/navigation/workspace"

export const Route = createFileRoute("/_workspace/settings/security")({
  validateSearch: validateGlobalSettingsSearch,
  head: () => ({ meta: [{ title: "Account security — Pi" }] }),
  component: () => null,
})
