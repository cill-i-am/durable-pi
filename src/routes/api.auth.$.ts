import { createFileRoute } from "@tanstack/react-router"

import { createAuth, sameOrigin } from "../auth/server"
import { getEnv } from "../env"

async function handle(request: Request) {
  const response = await createAuth(getEnv()).handler(request)
  response.headers.set("Cache-Control", "private, no-store")
  response.headers.set("Pragma", "no-cache")
  response.headers.set("X-Content-Type-Options", "nosniff")
  return response
}

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      POST: ({ request }) => {
        const env = getEnv()
        if (!sameOrigin(request, env.APP_URL))
          return Response.json({ error: "Untrusted origin" }, { status: 403 })
        return handle(request)
      },
    },
  },
})
