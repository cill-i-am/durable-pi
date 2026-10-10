import { createFileRoute } from "@tanstack/react-router"
import { createAuth, sameOrigin } from "../auth/server"
import { getEnv, runInBackground } from "../env"

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) =>
        createAuth(getEnv(), false, runInBackground).handler(request),
      POST: ({ request }) => {
        const env = getEnv()
        if (!sameOrigin(request, env.APP_URL))
          return Response.json({ error: "Untrusted origin" }, { status: 403 })
        return createAuth(env, false, runInBackground).handler(request)
      },
    },
  },
})
