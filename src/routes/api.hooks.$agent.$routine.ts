import { createFileRoute } from "@tanstack/react-router"

import { ownerAccounts } from "../auth/adapters/accounts"
import { getEnv } from "../env"
import { receiveWebhook } from "../webhooks/adapters/public"

export const Route = createFileRoute("/api/hooks/$agent/$routine")({
  server: {
    handlers: {
      POST: ({ request, params }) => {
        const env = getEnv()
        const accounts = ownerAccounts(env.DB)
        return receiveWebhook(request, params.agent, params.routine, {
          owner: () => accounts.owner(env.OWNER_EMAIL),
          AGENT_SERVICE: env.AGENT_SERVICE,
        })
      },
    },
  },
})
