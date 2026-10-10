import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { drizzle } from "drizzle-orm/d1"
import type { WebsiteEnv } from "../../alchemy.run"
import * as schema from "./schema"
import { passwordResetEmail, PASSWORD_RESET_SECONDS } from "./password-email"

export function createAuth(
  env: WebsiteEnv,
  allowOwnerSetup = false,
  backgroundTask?: (task: Promise<unknown>) => void
) {
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
      resetPasswordTokenExpiresIn: PASSWORD_RESET_SECONDS,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, token }) => {
        if (user.email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) return
        try {
          await env.AUTH_EMAIL.send(
            passwordResetEmail(env.APP_URL, token, env.OWNER_EMAIL)
          )
        } catch {
          // Do not log provider errors: they can contain recipient/message contents.
          // Keep the public response identical for existing and unknown accounts.
          console.error("Password reset email delivery failed")
        }
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 30,
      customRules: {
        "/request-password-reset": { window: 600, max: 3 },
        "/reset-password": { window: 600, max: 10 },
      },
    },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    advanced: {
      useSecureCookies: env.APP_URL.startsWith("https://"),
      ipAddress: {
        ipAddressHeaders: env.APP_URL.startsWith("https://")
          ? ["cf-connecting-ip"]
          : ["x-forwarded-for"],
      },
      ...(backgroundTask
        ? { backgroundTasks: { handler: backgroundTask } }
        : {}),
    },
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

/** Keep bookmarks working while mutations remain bound to the configured origin. */
export function canonicalOriginResponse(request: Request, appUrl: string) {
  const target = new URL(appUrl),
    source = new URL(request.url)
  if (target.protocol !== "https:" || source.origin === target.origin) return
  if (request.method !== "GET" && request.method !== "HEAD")
    return Response.json(
      { error: `Open ${target.origin} to continue.` },
      { status: 403 }
    )
  target.pathname = source.pathname
  target.search = source.search
  return new Response(null, {
    status: 302,
    headers: { Location: target.href, "Cache-Control": "no-store" },
  })
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
