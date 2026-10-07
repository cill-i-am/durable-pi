import { createFileRoute } from "@tanstack/react-router"
import { createAuth } from "../auth/server"
import { getEnv } from "../env"

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => createAuth(getEnv()).handler(request),
      POST: ({ request }) => createAuth(getEnv()).handler(request),
    },
  },
})
