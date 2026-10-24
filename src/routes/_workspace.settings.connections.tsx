import { createFileRoute } from "@tanstack/react-router"

import { validateConnectionSettingsSearch } from "@/navigation/workspace"

export const Route = createFileRoute("/_workspace/settings/connections")({
  validateSearch: validateConnectionSettingsSearch,
  head: () => ({ meta: [{ title: "Connections — Pi" }] }),
  component: () => null,
})
