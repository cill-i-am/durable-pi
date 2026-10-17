import { createFileRoute } from "@tanstack/react-router"
import { Effect } from "effect"

import { accountAvatar } from "../auth/adapters/avatar"
import { authorizedMember, createAuth } from "../auth/server"
import { getEnv } from "../env"

function handle(request: Request) {
  const env = getEnv()
  return accountAvatar(request, {
    appUrl: env.APP_URL,
    owner: () => Effect.runPromise(authorizedMember(request, env)),
    bucket: env.USER_AVATARS,
    updateImage: async (image) => {
      const response = await createAuth(env).api.updateUser({
        headers: request.headers,
        body: { image },
        asResponse: true,
      })
      await response.body?.cancel()
      if (!response.ok) throw new Error("Profile update failed")
      return response.headers
    },
  })
}
export const Route = createFileRoute("/api/account/avatar")({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      POST: ({ request }) => handle(request),
      DELETE: ({ request }) => handle(request),
    },
  },
})
