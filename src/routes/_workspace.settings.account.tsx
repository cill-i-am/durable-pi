import { createFileRoute } from "@tanstack/react-router"

import { validateGlobalSettingsSearch } from "@/navigation/workspace"

export const Route = createFileRoute("/_workspace/settings/account")({
  validateSearch: validateGlobalSettingsSearch,
  head: () => ({ meta: [{ title: "Account — Pi" }] }),
  component: () => null,
})
