import { passkey } from "@better-auth/passkey"
import type { GenericEndpointContext } from "better-auth"
import { APIError, getSessionFromCtx, isAPIError } from "better-auth/api"
import { Schema } from "effect"

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

function requireDeviceVerification(verified: boolean | undefined) {
  if (!verified)
    throw new APIError("FORBIDDEN", {
      code: "PASSKEY_DEVICE_VERIFICATION_REQUIRED",
      message: "Unlock your device to use this passkey, then try again.",
    })
}

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
      afterVerification: ({ verification }) => {
        requireDeviceVerification(verification.registrationInfo?.userVerified)
      },
    },
    authentication: {
      afterVerification: ({ verification }) => {
        requireDeviceVerification(verification.authenticationInfo.userVerified)
      },
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

/** The plugin requests preferred verification for sign-in by default. Require
 * it in the browser too; the verified callbacks above enforce it on the server. */
export function passkeyAuthenticationOptions(
  ctx: GenericEndpointContext,
  returned: unknown
) {
  if (
    ctx.path !== "/passkey/generate-authenticate-options" ||
    isAPIError(returned)
  )
    return
  const options = Schema.decodeUnknownSync(
    Schema.Record(Schema.String, Schema.Unknown)
  )(returned)
  return ctx.json({ ...options, userVerification: "required" })
}
