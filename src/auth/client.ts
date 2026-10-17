import { twoFactorClient } from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"

import { workspaceReturnPath } from "@/navigation/workspace"

import { sessionFetch } from "./session-fetch"

export const authFetch = sessionFetch((...args) => fetch(...args))

export const authClient = createAuthClient({
  plugins: [
    twoFactorClient({
      onTwoFactorRedirect: () => {
        const returnTo = workspaceReturnPath(
          window.location.pathname + window.location.search
        )
        window.location.assign(
          `/two-factor?returnTo=${encodeURIComponent(returnTo)}`
        )
      },
    }),
  ],
  sessionOptions: { refetchInterval: 30, refetchOnWindowFocus: true },
  fetchOptions: { customFetchImpl: authFetch },
})
