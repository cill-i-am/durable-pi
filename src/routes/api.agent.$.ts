import { createFileRoute } from "@tanstack/react-router"

import { agentProxy } from "../auth/adapters/agent-proxy"
import { authorizedMember } from "../auth/server"
import { getEnv, runInBackground } from "../env"

function handle(request: Request) {
  const env = getEnv()
  return agentProxy(request, {
    appUrl: env.APP_URL,
    owner: authorizedMember(request, env),
    forward: (forwarded) => env.AGENT_SERVICE.fetch(forwarded),
    own: runInBackground,
  })
}
export const Route = createFileRoute("/api/agent/$")({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      POST: ({ request }) => handle(request),
    },
  },
})
