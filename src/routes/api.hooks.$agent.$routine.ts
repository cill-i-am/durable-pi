import { createFileRoute } from "@tanstack/react-router"
import { getEnv } from "../env"
import { receiveWebhook } from "../webhooks/public"

export const Route = createFileRoute("/api/hooks/$agent/$routine")({
  server: {
    handlers: {
      POST: ({ request, params }) =>
        receiveWebhook(request, params.agent, params.routine, getEnv()),
    },
  },
})
