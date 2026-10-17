import { createFileRoute } from "@tanstack/react-router"

import { TwoFactorChallenge } from "@/features/auth"
import { validateAuthSearch } from "@/navigation/workspace"

export const Route = createFileRoute("/two-factor")({
  validateSearch: validateAuthSearch,
  head: () => ({
    meta: [
      { title: "Verify your sign-in — Pi" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: TwoFactorChallenge,
})
