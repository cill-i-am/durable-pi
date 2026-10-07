import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { drizzle } from "drizzle-orm/d1"
import type { WebsiteEnv } from "../../alchemy.run"
import * as schema from "./schema"

export function createAuth(env: WebsiteEnv, allowOwnerSetup = false) {
  return betterAuth({
    appName: "Durable Pi",
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.APP_URL,
    trustedOrigins: [env.APP_URL],
    database: drizzleAdapter(drizzle(env.DB), { provider: "sqlite", schema }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !allowOwnerSetup,
      minPasswordLength: 12,
    },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 30 },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    advanced: { useSecureCookies: env.APP_URL.startsWith("https://") },
    databaseHooks: {
      user: {
        create: {
          before: async (data) => {
            if (
              !allowOwnerSetup ||
              data.email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()
            )
              return false
            return { data }
          },
        },
      },
    },
  })
}

export async function authorizedOwner(request: Request, env: WebsiteEnv) {
  const session = await createAuth(env).api.getSession({
    headers: request.headers,
  })
  return session &&
    session.user.email.toLowerCase() === env.OWNER_EMAIL.toLowerCase()
    ? session.user
    : null
}
export function sameOrigin(request: Request, appUrl: string) {
  return request.headers.get("origin") === new URL(appUrl).origin
}
export async function matchesSecret(actual: string, expected: string) {
  if (!expected || !actual) return false
  const digest = (s: string) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))
  const [a, b] = await Promise.all([digest(actual), digest(expected)])
  const left = new Uint8Array(a),
    right = new Uint8Array(b)
  let diff = 0
  for (let i = 0; i < left.length; i++) diff |= left[i]! ^ right[i]!
  return diff === 0
}
