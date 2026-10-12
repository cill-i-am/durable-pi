import { validateAuthSearch } from "@/navigation/workspace"
import { createFileRoute } from "@tanstack/react-router"
import { ResetPassword } from "@/features/auth"

export const Route = createFileRoute("/reset-password")({
  validateSearch: validateAuthSearch,
  head: () => ({
    meta: [
      { title: "Choose a new password — Pi" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: ResetPassword,
})
