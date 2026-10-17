import { betterAuth, type BetterAuthOptions } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api"
import { twoFactor } from "better-auth/plugins"
import { drizzle } from "drizzle-orm/d1"
import { Effect, Schema } from "effect"

import type { WebsiteEnv } from "../../alchemy.run"
import { familyOrganization, guardFamilyAuth } from "../family/adapters/auth"
import {
  familyDirectory,
  type FamilyDirectory,
} from "../family/adapters/directory"
import { verificationEmail } from "../family/adapters/mail"
import { nativeOperation } from "../shared/interop"
import { OwnerSessionUnavailable, ownerSession } from "./owner-session"
import {
  accountPasskeys,
  guardPasskeyAuth,
  passkeyAuthenticationOptions,
} from "./passkeys"
import { passwordResetEmail, PASSWORD_RESET_SECONDS } from "./password-email"
import * as schema from "./schema"

export type AuthEnv = Pick<
  WebsiteEnv,
  "DB" | "BETTER_AUTH_SECRET" | "APP_URL" | "OWNER_EMAIL" | "AUTH_EMAIL"
> & { AGENT_SERVICE?: { fetch: (request: Request) => Promise<Response> } }
export type AgentPrincipal = typeof schema.user.$inferSelect

export function createAuth(
  env: AuthEnv,
  allowOwnerSetup = false,
  backgroundTask?: (task: Promise<unknown>) => void,
  principal?: AgentPrincipal
) {
  return betterAuth({
    ...authOptions(
      env,
      allowOwnerSetup,
      backgroundTask,
      familyDirectory(env.DB, env.OWNER_EMAIL),
      async (id) => {
        if (!env.AGENT_SERVICE) return
        const response = await env.AGENT_SERVICE.fetch(
          new Request("https://agent.internal/api/agent/family/suspend", {
            method: "POST",
            headers: { "x-owner-id": id },
          })
        )
        await response.body?.cancel()
        if (!response.ok)
          throw new Error("Family suspension notification failed")
      },
      principal
    ),
    database: drizzleAdapter(drizzle(env.DB), { provider: "sqlite", schema }),
  })
}

export function authOptions(
  env: Pick<
    WebsiteEnv,
    "BETTER_AUTH_SECRET" | "APP_URL" | "OWNER_EMAIL" | "AUTH_EMAIL"
  >,
  allowOwnerSetup = false,
  backgroundTask?: (task: Promise<unknown>) => void,
  family?: FamilyDirectory,
  onMemberRemoved?: (id: string) => Promise<void>,
  principal?: AgentPrincipal
) {
  const verificationDeliveryFailures = new Set<string>()
  const invitationDeliveryFailures = new Set<string>()
  return {
    appName: "Durable Pi",
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.APP_URL,
    trustedOrigins: [env.APP_URL],
    plugins: [
      accountPasskeys(env.APP_URL),
      familyOrganization(env, family, onMemberRemoved, (id, delivery) => {
        if (delivery === "failed") invitationDeliveryFailures.add(id)
        else invitationDeliveryFailures.delete(id)
      }),
      twoFactor({
        issuer: "Durable Pi",
        backupCodeOptions: { storeBackupCodes: "encrypted" },
      }),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Only a server-side API invocation can use an actor principal. HTTP
        // requests always carry Request and must authenticate their own session.
        if (principal && !ctx.request) {
          const now = new Date()
          ctx.context.session = {
            user: principal,
            session: {
              id: "agent-action",
              userId: principal.id,
              token: "internal-agent-action",
              expiresAt: new Date(now.getTime() + 60_000),
              createdAt: now,
              updatedAt: now,
            },
          }
        }
        if (family) await guardFamilyAuth(ctx, family)
        else if (ctx.path.startsWith("/organization/"))
          throw new APIError("FORBIDDEN", {
            message: "Family access is unavailable.",
          })
        await guardPasskeyAuth(ctx, family, !!principal)
        if (
          ctx.path.startsWith("/two-factor/") &&
          Schema.is(Schema.Struct({ trustDevice: Schema.Literal(true) }))(
            ctx.body
          )
        )
          throw new APIError("BAD_REQUEST", {
            code: "TRUST_DEVICE_DISABLED",
            message: "Verify your authenticator at each sign-in.",
          })
      }),
      after: createAuthMiddleware(async (ctx) => {
        const options = passkeyAuthenticationOptions(ctx, ctx.context.returned)
        if (options) return options
        if (ctx.path === "/send-verification-email") {
          const body = Schema.decodeUnknownOption(
            Schema.Struct({ email: Schema.String })
          )(ctx.body)
          if (
            body._tag === "Some" &&
            verificationDeliveryFailures.has(body.value.email.toLowerCase())
          )
            throw new APIError("BAD_GATEWAY", {
              message:
                "The verification email couldn’t be delivered. Please try again.",
            })
        }
        if (ctx.path === "/organization/invite-member" && family) {
          const result = Schema.decodeUnknownOption(
            Schema.Struct({ id: Schema.String })
          )(ctx.context.returned)
          if (
            result._tag === "Some" &&
            (invitationDeliveryFailures.has(result.value.id) ||
              (await family.deliveryFailed(result.value.id)))
          )
            throw new APIError("BAD_GATEWAY", {
              code: "INVITATION_EMAIL_FAILED",
              message:
                "The invitation was saved, but the email couldn’t be delivered. Use Resend in Family settings to try again.",
            })
        }
        if (
          (ctx.path === "/two-factor/verify-totp" ||
            ctx.path === "/two-factor/disable") &&
          ctx.context.session &&
          ctx.context.newSession &&
          !isAPIError(ctx.context.returned) &&
          ctx.context.newSession.session.token !==
            ctx.context.session.session.token
        ) {
          const current = ctx.context.newSession.session
          await ctx.context.adapter.deleteMany({
            model: "session",
            where: [
              { field: "userId", value: current.userId },
              { field: "token", operator: "ne", value: current.token },
            ],
          })
        }
      }),
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: !allowOwnerSetup && !family,
      minPasswordLength: 12,
      resetPasswordTokenExpiresIn: PASSWORD_RESET_SECONDS,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, token }) => {
        if (
          user.email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase() &&
          !(await family?.access(user.id)) &&
          !(await family?.recoverable(user.email))
        )
          return
        try {
          await env.AUTH_EMAIL.send(
            passwordResetEmail(env.APP_URL, token, user.email)
          )
        } catch {
          console.error("Password reset email delivery failed")
        }
      },
    },
    emailVerification: {
      sendOnSignUp: !!family,
      expiresIn: 60 * 60,
      sendVerificationEmail: async ({ user, token }, request) => {
        if (user.email.toLowerCase() === env.OWNER_EMAIL.toLowerCase()) return
        const id = request?.headers.get("x-family-invitation") ?? undefined
        if (!family || !id || !(await family.pending(id, user.email))) return
        try {
          await env.AUTH_EMAIL.send(
            verificationEmail(env.APP_URL, token, user.email, id)
          )
          verificationDeliveryFailures.delete(user.email.toLowerCase())
        } catch {
          verificationDeliveryFailures.add(user.email.toLowerCase())
        }
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 30,
      customRules: {
        "/get-session": { window: 60, max: 120 },
        "/request-password-reset": { window: 600, max: 3 },
        "/reset-password": { window: 600, max: 10 },
        "/sign-up/email": { window: 600, max: 5 },
        "/send-verification-email": { window: 600, max: 3 },
        "/organization/invite-member": { window: 600, max: 20 },
        "/passkey/generate-authenticate-options": { window: 60, max: 20 },
        "/passkey/verify-authentication": { window: 60, max: 10 },
        "/passkey/generate-register-options": { window: 60, max: 10 },
        "/passkey/verify-registration": { window: 60, max: 10 },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    advanced: {
      disableOriginCheck: false,
      disableCSRFCheck: false,
      useSecureCookies: env.APP_URL.startsWith("https://"),
      ipAddress: {
        ipAddressHeaders: env.APP_URL.startsWith("https://")
          ? ["cf-connecting-ip"]
          : ["x-forwarded-for"],
      },
      ...(backgroundTask && !family
        ? { backgroundTasks: { handler: backgroundTask } }
        : {}),
    },
    databaseHooks: {
      user: {
        create: {
          before: async (data, ctx) => {
            const owner =
              allowOwnerSetup &&
              data.email.toLowerCase() === env.OWNER_EMAIL.toLowerCase()
            const id = ctx?.headers?.get("x-family-invitation")
            if (
              !owner &&
              !(family && id && (await family.pending(id, data.email)))
            )
              return false
            return { data }
          },
          after: async (data) => {
            await family?.bootstrap(data.id, data.email)
          },
        },
      },
    },
  } satisfies BetterAuthOptions
}

export function authorizedOwner(request: Request, env: WebsiteEnv) {
  return ownerSession(
    () =>
      createAuth(env).api.getSession({
        headers: request.headers,
        query: { disableCookieCache: true, disableRefresh: true },
      }),
    env.OWNER_EMAIL
  )
}
export function authorizedMember(request: Request, env: WebsiteEnv) {
  return nativeOperation(
    async () => {
      const session = await createAuth(env).api.getSession({
        headers: request.headers,
        query: { disableCookieCache: true, disableRefresh: true },
      })
      if (!session) return null
      const family = familyDirectory(env.DB, env.OWNER_EMAIL)
      await family.bootstrap(session.user.id, session.user.email)
      return (await family.access(session.user.id)) ? session.user : null
    },
    (cause) => new OwnerSessionUnavailable({ cause })
  ).pipe(Effect.withSpan("Identity.familySession"))
}
export function sameOrigin(request: Request, appUrl: string) {
  return request.headers.get("origin") === new URL(appUrl).origin
}

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
