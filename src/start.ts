import { createMiddleware, createStart } from "@tanstack/react-start"
import { canonicalOriginResponse } from "./auth/server"
import { getEnv } from "./env"

const canonicalOrigin = createMiddleware().server(
  ({ request, next }) =>
    canonicalOriginResponse(request, getEnv().APP_URL) ?? next()
)

export const startInstance = createStart(() => ({
  requestMiddleware: [canonicalOrigin],
}))
