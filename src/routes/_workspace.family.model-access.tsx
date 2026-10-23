import { createFileRoute } from "@tanstack/react-router"

import { validateGlobalSettingsSearch } from "@/navigation/workspace"

export const Route = createFileRoute("/_workspace/family/model-access")({
  validateSearch: validateGlobalSettingsSearch,
  head: () => ({ meta: [{ title: "Model access — Pi" }] }),
  component: () => null,
})
