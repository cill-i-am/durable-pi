import { createFileRoute } from "@tanstack/react-router"
import { Effect } from "effect"

import { authorizedMember } from "../auth/server"
import { getEnv } from "../env"
import { clientErrorRequest } from "../observability/client-error-http"

export const Route = createFileRoute("/api/diagnostics/client-error")({
  server: {
    handlers: {
      POST: ({ request }) => {
        const env = getEnv()
        return clientErrorRequest(request, {
          appUrl: env.APP_URL,
          authorize: async () =>
            !!(await Effect.runPromise(authorizedMember(request, env))),
        })
      },
    },
  },
})
