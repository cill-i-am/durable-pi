import { createFileRoute } from "@tanstack/react-router"
import { TwoFactorChallenge } from "@/features/auth"

export const Route = createFileRoute("/two-factor")({
  head: () => ({
    meta: [
      { title: "Verify your sign-in — Pi" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: TwoFactorChallenge,
})
