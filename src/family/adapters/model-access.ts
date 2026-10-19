import { and, eq, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import { alias } from "drizzle-orm/sqlite-core"
import { Effect } from "effect"

import { member, user } from "../../auth/schema"
import { CredentialUnavailable } from "../../inference/credentials"
import { nativeOperation } from "../../shared/interop"
import { FAMILY_ID } from "../contracts"

/** One live database snapshot checks both model owner and member. No cache.
 * An absent candidate is only a bootstrap hint: the caller must also match the
 * model owner's Durable Object identity before accepting the result. */
export const familyModelAccess = Effect.fn("Family.modelAccess")(function* (
  binding: D1Database,
  ownerEmail: string,
  candidate?: string
) {
  const db = drizzle(binding),
    ownerMember = alias(member, "model_owner_member"),
    ownerUser = alias(user, "model_owner_user")
  const row = yield* nativeOperation(
    () =>
      db
        .select({
          modelOwner: ownerUser.id,
          owner: user.id,
          role: member.role,
          email: user.email,
          verified: user.emailVerified,
          joinedAt: member.createdAt,
          membershipId: member.id,
        })
        .from(ownerMember)
        .innerJoin(ownerUser, eq(ownerMember.userId, ownerUser.id))
        .innerJoin(
          member,
          and(
            eq(member.organizationId, FAMILY_ID),
            eq(member.userId, candidate ?? ownerUser.id)
          )
        )
        .innerJoin(user, eq(member.userId, user.id))
        .where(
          and(
            eq(ownerMember.organizationId, FAMILY_ID),
            eq(ownerMember.role, "owner"),
            sql`lower(${ownerUser.email}) = lower(${ownerEmail})`
          )
        )
        .get(),
    () =>
      new CredentialUnavailable({
        message: "Could not confirm family model access. Please try again.",
      })
  )
  if (!row || (row.role !== "owner" && row.role !== "member")) return null
  if (
    !(
      row.role === "owner" &&
      row.email.toLowerCase() === ownerEmail.toLowerCase()
    ) &&
    !row.verified
  )
    return null
  return {
    owner: row.owner,
    modelOwner: row.modelOwner,
    joinedAt: row.joinedAt.getTime(),
    membershipId: row.membershipId,
  }
})
