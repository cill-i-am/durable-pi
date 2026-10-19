import { createFileRoute } from "@tanstack/react-router"
import { Effect } from "effect"

import { ownerAccounts } from "../auth/adapters/accounts"
import { deploymentResponse } from "../deployment/http"
import { getEnv, runInBackground } from "../env"

export const Route = createFileRoute("/api/deployment")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const env = getEnv()
        const pending = deploymentResponse(
          request,
          env.SETUP_TOKEN,
          async () => {
            const owner = await Effect.runPromise(
              ownerAccounts(env.DB).owner(env.OWNER_EMAIL)
            )
            if (!owner) throw new Error("Owner is unavailable")
            const response = await env.AGENT_SERVICE.fetch(
              new Request("https://agent.internal/__deployment", {
                headers: { "x-owner-id": owner },
                signal: request.signal,
              })
            )
            if (!response.ok) {
              await response.body?.cancel()
              throw new Error("Agent deployment is unavailable")
            }
            return response.json<{ worker: string; agents: string[] }>()
          }
        )
        runInBackground(pending)
        return pending
      },
    },
  },
})
