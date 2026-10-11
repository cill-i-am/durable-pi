import { createAuthClient } from "better-auth/react"
import { twoFactorClient } from "better-auth/client/plugins"
import { sessionFetch } from "./session-fetch"

export const authClient = createAuthClient({
  plugins: [twoFactorClient({ twoFactorPage: "/two-factor" })],
  sessionOptions: { refetchInterval: 30, refetchOnWindowFocus: true },
  fetchOptions: { customFetchImpl: sessionFetch((...args) => fetch(...args)) },
})
