import { createFileRoute } from "@tanstack/react-router"

import { validateGlobalSettingsSearch } from "@/navigation/workspace"

export const Route = createFileRoute("/_workspace/settings/skills")({
  validateSearch: validateGlobalSettingsSearch,
  head: () => ({ meta: [{ title: "Skills — Pi" }] }),
  component: () => null,
})
