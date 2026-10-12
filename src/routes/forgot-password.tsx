import { validateAuthSearch } from "@/navigation/workspace"
import { createFileRoute } from "@tanstack/react-router"
import { ForgotPassword } from "@/features/auth"

export const Route = createFileRoute("/forgot-password")({
  validateSearch: validateAuthSearch,
  head: () => ({
    meta: [
      { title: "Reset your password — Pi" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: ForgotPassword,
})
