import { createFileRoute } from "@tanstack/react-router"
import { createAuth } from "../auth/server"
import { ownerSetup } from "../auth/adapters/owner-setup"
import { ownerAccounts } from "../auth/adapters/accounts"
import { getEnv, runInBackground } from "../env"

export const Route = createFileRoute("/api/setup")({
  server: {
    handlers: {
      POST: ({ request }) => {
        const env = getEnv()
        return ownerSetup(request, {
          appUrl: env.APP_URL,
          ownerEmail: env.OWNER_EMAIL,
          secret: env.SETUP_TOKEN,
          registered: ownerAccounts(env.DB).registered,
          signUp: (body) =>
            createAuth(env, true)
              .api.signUpEmail({ body })
              .then(() => undefined),
          own: runInBackground,
        })
      },
    },
  },
})
