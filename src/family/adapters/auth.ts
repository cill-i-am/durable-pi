import type { GenericEndpointContext } from "better-auth"
import { APIError, getSessionFromCtx } from "better-auth/api"
import { organization } from "better-auth/plugins"
import { Schema } from "effect"

import type { WebsiteEnv } from "../../../alchemy.run"
import { FAMILY_ID } from "../contracts"
import type { FamilyDirectory } from "./directory"
import { invitationEmail } from "./mail"

const ownerPaths = new Set([
  "/organization/invite-member",
  "/organization/cancel-invitation",
  "/organization/remove-member",
  "/organization/list-invitations",
])
const invitationPaths = new Set([
  "/organization/accept-invitation",
  "/organization/get-invitation",
  "/organization/list-user-invitations",
])

const denied = () =>
  new APIError("FORBIDDEN", {
    code: "FAMILY_PERMISSION_DENIED",
    message: "You don’t have permission to change family access.",
  })

/** Keep the native plugin's invitation and membership transactions, while
 * closing organization creation, role elevation and owner removal. */
export async function guardFamilyAuth(
  ctx: GenericEndpointContext,
  family: FamilyDirectory
) {
  if (!ctx.path?.startsWith("/organization/")) return
  if (!ownerPaths.has(ctx.path) && !invitationPaths.has(ctx.path))
    throw denied()
  const session = await getSessionFromCtx(ctx, {
    disableCookieCache: true,
    disableRefresh: true,
  })
  if (!session)
    throw new APIError("UNAUTHORIZED", { message: "Sign in to continue." })
  await family.bootstrap(session.user.id, session.user.email)
  if (
    ownerPaths.has(ctx.path) &&
    (await family.access(session.user.id))?.role !== "owner"
  )
    throw denied()
  const body = Schema.decodeUnknownSync(
    Schema.Struct({
      organizationId: Schema.optional(Schema.String),
      role: Schema.optional(Schema.String),
      email: Schema.optional(Schema.String),
    })
  )(ctx.body ?? {})
  const query = Schema.decodeUnknownSync(
    Schema.Struct({ organizationId: Schema.optional(Schema.String) })
  )(ctx.query ?? {})
  const organizationId = body.organizationId ?? query.organizationId
  if (organizationId !== undefined && organizationId !== FAMILY_ID)
    throw denied()
  if (
    ctx.path === "/organization/invite-member" &&
    (body.role !== "member" || organizationId !== FAMILY_ID)
  )
    throw denied()
  if (ctx.path === "/organization/invite-member" && body.email)
    await family.cancelExpiredInvitations(body.email)
}

export function familyOrganization(
  env: Pick<WebsiteEnv, "AUTH_EMAIL" | "APP_URL">,
  family?: FamilyDirectory,
  onMemberRemoved?: (id: string) => Promise<void>,
  onDelivery?: (id: string, delivery: "sent" | "failed") => void
) {
  return organization({
    allowUserToCreateOrganization: false,
    disableOrganizationDeletion: true,
    invitationExpiresIn: 60 * 60 * 24 * 7,
    requireEmailVerificationOnInvitation: true,
    sendInvitationEmail: async (data) => {
      // Better Auth intentionally absorbs mail errors. Persist the receipt and
      // let our after hook report failure without losing the pending invite.
      let delivery: "sent" | "failed" = "sent"
      try {
        await env.AUTH_EMAIL.send(
          invitationEmail(
            env.APP_URL,
            data.id,
            data.email,
            data.inviter.user.name,
            data.organization.name
          )
        )
      } catch {
        delivery = "failed"
      }
      onDelivery?.(data.id, delivery)
      await family?.recordDelivery(data.id, delivery)
    },
    organizationHooks: {
      beforeRemoveMember: async ({ member }) => {
        if (member.organizationId !== FAMILY_ID || member.role !== "member")
          throw denied()
      },
      afterRemoveMember: async ({ member }) => {
        try {
          await onMemberRemoved?.(member.userId)
        } catch {
          console.error(
            "Family access was revoked; agent suspension notification needs retry."
          )
        }
      },
      beforeAddMember: async ({ member }) => {
        if (member.organizationId !== FAMILY_ID || member.role !== "member")
          throw denied()
      },
      beforeAcceptInvitation: async ({ invitation }) => {
        if (
          invitation.organizationId !== FAMILY_ID ||
          invitation.role !== "member"
        )
          throw denied()
      },
    },
  })
}
