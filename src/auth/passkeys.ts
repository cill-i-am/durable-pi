import { passkey } from "@better-auth/passkey"
import type { GenericEndpointContext } from "better-auth"
import { APIError, getSessionFromCtx } from "better-auth/api"

import type { FamilyDirectory } from "../family/adapters/directory"

const registration = new Set([
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
])
const management = new Set([
  ...registration,
  "/passkey/list-user-passkeys",
  "/passkey/update-passkey",
  "/passkey/delete-passkey",
])

export function accountPasskeys(appUrl: string) {
  const origin = new URL(appUrl)
  return passkey({
    rpID: origin.hostname,
    rpName: "Pi",
    origin: origin.origin,
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
    registration: {
      requireSession: true,
    },
  })
}

/** Enrollment always requires a real browser's fresh session and device proof.
 * The native plugin scopes key management to the authenticated person. */
export async function guardPasskeyAuth(
  ctx: GenericEndpointContext,
  family: FamilyDirectory | undefined,
  agentPrincipal: boolean
) {
  if (!management.has(ctx.path)) return
  if (registration.has(ctx.path) && agentPrincipal && !ctx.request)
    throw new APIError("FORBIDDEN", {
      message: "Open Account security to add a passkey on your device.",
    })
  const session = await getSessionFromCtx(ctx, {
    disableCookieCache: true,
    disableRefresh: true,
  })
  if (!session)
    throw new APIError("UNAUTHORIZED", { message: "Sign in to continue." })
  await family?.bootstrap(session.user.id, session.user.email)
  if (!family || !(await family.access(session.user.id)))
    throw new APIError("FORBIDDEN", {
      message: "Your account does not have family access.",
    })
}
