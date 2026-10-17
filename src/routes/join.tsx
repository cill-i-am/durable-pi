import { createFileRoute } from "@tanstack/react-router"

import { JoinFamily } from "@/features/family/join"

export const Route = createFileRoute("/join")({
  head: () => ({
    meta: [
      { title: "Join your family — Pi" },
      { name: "referrer", content: "no-referrer" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: JoinFamily,
})
