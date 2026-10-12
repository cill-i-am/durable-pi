import { createAuthClient } from "better-auth/react"
import { twoFactorClient } from "better-auth/client/plugins"
import { workspaceReturnPath } from "@/navigation/workspace"
import { sessionFetch } from "./session-fetch"

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
  fetchOptions: { customFetchImpl: sessionFetch((...args) => fetch(...args)) },
})
