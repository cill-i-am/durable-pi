import { isAPIError } from "better-auth/api"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import { Schema } from "effect"

import { user } from "../../auth/schema"
import { createAuth, type AuthEnv } from "../../auth/server"
import { nativeOperation } from "../../shared/interop"
import { FAMILY_ID, FamilyAction, FamilyActionFailed } from "../contracts"
import { familyDirectory } from "./directory"

/** Actor identity is supplied by the host, never by model arguments. Native
 * Better Auth APIs enforce the same organization policy as the web endpoints. */
export function familyAgentAction(
  env: AuthEnv,
  userId: string,
  input: unknown
) {
  return nativeOperation(
    async () => {
      const action = Schema.decodeUnknownSync(FamilyAction)(input)
      const directory = familyDirectory(env.DB, env.OWNER_EMAIL)
      const access = await directory.access(userId)
      if (!access)
        throw new FamilyActionFailed({
          message: "Your family access has ended.",
        })
      const snapshot = await directory.snapshot(access)
      if (action.action === "read") return snapshot
      if (access.role !== "owner")
        throw new FamilyActionFailed({
          message: "Only the family admin can manage invitations and members.",
        })
      const principal = await drizzle(env.DB)
        .select()
        .from(user)
        .where(eq(user.id, userId))
        .get()
      if (!principal)
        throw new FamilyActionFailed({
          message: "Could not confirm your account.",
        })
      const auth = createAuth(env, false, undefined, principal)
      const headers = new Headers({ origin: env.APP_URL })
      switch (action.action) {
        case "invite": {
          const invited = await auth.api.createInvitation({
            headers,
            body: {
              organizationId: FAMILY_ID,
              role: "member",
              email: action.email,
            },
          })
          return { status: "sent", email: invited.email }
        }
        case "resend": {
          const invitation = snapshot.invitations.find(
            (item) => item.id === action.invitationId
          )
          if (!invitation)
            throw new FamilyActionFailed({
              message:
                "That pending invitation was not found. Read family settings again.",
            })
          await auth.api.createInvitation({
            headers,
            body: {
              organizationId: FAMILY_ID,
              role: "member",
              email: invitation.email,
              resend: true,
            },
          })
          return { status: "sent", email: invitation.email }
        }
        case "cancel": {
          if (
            !snapshot.invitations.some(
              (item) => item.id === action.invitationId
            )
          )
            throw new FamilyActionFailed({
              message: "That pending invitation was not found.",
            })
          await auth.api.cancelInvitation({
            headers,
            body: { invitationId: action.invitationId },
          })
          return { status: "cancelled" }
        }
        case "remove": {
          const member = snapshot.members.find(
            (item) => item.id === action.memberId
          )
          if (!member || member.role === "owner")
            throw new FamilyActionFailed({
              message:
                "Choose a current family member. The admin cannot be removed.",
            })
          await auth.api.removeMember({
            headers,
            body: { organizationId: FAMILY_ID, memberIdOrEmail: member.id },
          })
          return {
            status: "removed",
            name: member.name,
            privateDataRetained: true,
          }
        }
      }
    },
    (cause) => {
      const known = Schema.decodeUnknownOption(FamilyActionFailed)(cause)
      if (known._tag === "Some") return known.value
      if (isAPIError(cause))
        return new FamilyActionFailed({ message: cause.message })
      return new FamilyActionFailed({
        message:
          "Family settings could not be updated. Read the current family state before retrying an invitation or removal.",
      })
    }
  )
}
