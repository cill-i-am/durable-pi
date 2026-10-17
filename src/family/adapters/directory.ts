import { and, eq, gt, lte, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"

import { invitation, member, organization, user } from "../../auth/schema"
import {
  FAMILY_ID,
  type FamilySnapshot,
  type InvitationPreview,
} from "../contracts"

export interface FamilyAccess {
  userId: string
  membershipId: string
  role: "owner" | "member"
  joinedAt: number
}

export interface FamilyDirectory {
  bootstrap: (id: string, email: string) => Promise<void>
  access: (id: string) => Promise<FamilyAccess | null>
  owner: () => Promise<{ id: string; name: string } | null>
  pending: (id: string, email: string) => Promise<boolean>
  recoverable: (email: string) => Promise<boolean>
  recordDelivery: (id: string, delivery: "sent" | "failed") => Promise<void>
  deliveryFailed: (id: string) => Promise<boolean>
  cancelExpiredInvitations: (email: string) => Promise<void>
  preview: (id: string) => Promise<InvitationPreview | null>
  snapshot: (access: FamilyAccess) => Promise<FamilySnapshot>
}

/** Better Auth owns membership writes. Bootstrap is the one idempotent,
 * deployment-owner-only initialization, including existing installations. */
export function familyDirectory(
  binding: D1Database,
  ownerEmail: string
): FamilyDirectory {
  const db = drizzle(binding)
  const scope = eq(member.organizationId, FAMILY_ID)
  const owner = async () =>
    (await db
      .select({ id: user.id, name: user.name })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(
        and(
          scope,
          eq(member.role, "owner"),
          sql`lower(${user.email}) = lower(${ownerEmail})`
        )
      )
      .get()) ?? null
  return {
    bootstrap: async (id, email) => {
      if (email.toLowerCase() !== ownerEmail.toLowerCase()) return
      const existing = await db
        .select({ id: member.id })
        .from(member)
        .where(and(scope, eq(member.userId, id), eq(member.role, "owner")))
        .get()
      if (existing) return
      const now = new Date()
      await db.batch([
        db
          .insert(organization)
          .values({
            id: FAMILY_ID,
            name: "Barron family",
            slug: FAMILY_ID,
            createdAt: now,
          })
          .onConflictDoNothing(),
        db
          .insert(member)
          .values({
            id: "family-owner",
            organizationId: FAMILY_ID,
            userId: id,
            role: "owner",
            createdAt: now,
          })
          .onConflictDoNothing(),
      ])
    },
    access: async (id) => {
      const row = await db
        .select({
          membershipId: member.id,
          userId: member.userId,
          role: member.role,
          joinedAt: member.createdAt,
          verified: user.emailVerified,
          email: user.email,
        })
        .from(member)
        .innerJoin(user, eq(member.userId, user.id))
        .where(and(scope, eq(member.userId, id)))
        .get()
      if (!row || (row.role !== "owner" && row.role !== "member")) return null
      const configuredOwner =
        row.role === "owner" &&
        row.email.toLowerCase() === ownerEmail.toLowerCase()
      if (!configuredOwner && !row.verified) return null
      return {
        membershipId: row.membershipId,
        userId: row.userId,
        role: row.role,
        joinedAt: row.joinedAt.getTime(),
      }
    },
    owner,
    cancelExpiredInvitations: async (email) => {
      await db
        .update(invitation)
        .set({ status: "canceled" })
        .where(
          and(
            eq(invitation.organizationId, FAMILY_ID),
            eq(invitation.status, "pending"),
            lte(invitation.expiresAt, new Date()),
            sql`lower(${invitation.email}) = lower(${email})`
          )
        )
    },
    recoverable: async (email) =>
      !!(await db
        .select({ id: invitation.id })
        .from(invitation)
        .where(
          and(
            eq(invitation.organizationId, FAMILY_ID),
            eq(invitation.status, "pending"),
            gt(invitation.expiresAt, new Date()),
            sql`lower(${invitation.email}) = lower(${email})`
          )
        )
        .get()),
    recordDelivery: async (id, delivery) => {
      await db
        .update(invitation)
        .set({ delivery })
        .where(
          and(eq(invitation.id, id), eq(invitation.organizationId, FAMILY_ID))
        )
    },
    deliveryFailed: async (id) =>
      !!(await db
        .select({ id: invitation.id })
        .from(invitation)
        .where(
          and(
            eq(invitation.id, id),
            eq(invitation.organizationId, FAMILY_ID),
            eq(invitation.delivery, "failed")
          )
        )
        .get()),
    pending: async (id, email) =>
      !!(await db
        .select({ id: invitation.id })
        .from(invitation)
        .where(
          and(
            eq(invitation.id, id),
            eq(invitation.organizationId, FAMILY_ID),
            eq(invitation.status, "pending"),
            eq(invitation.role, "member"),
            gt(invitation.expiresAt, new Date()),
            sql`lower(${invitation.email}) = lower(${email})`
          )
        )
        .get()),
    preview: async (id) => {
      const row = await db
        .select({
          email: invitation.email,
          familyName: organization.name,
          inviterName: user.name,
          status: invitation.status,
          expiresAt: invitation.expiresAt,
        })
        .from(invitation)
        .innerJoin(organization, eq(invitation.organizationId, organization.id))
        .innerJoin(user, eq(invitation.inviterId, user.id))
        .where(
          and(eq(invitation.id, id), eq(invitation.organizationId, FAMILY_ID))
        )
        .get()
      if (!row) return null
      return {
        email: row.email,
        familyName: row.familyName,
        inviterName: row.inviterName,
        status:
          row.status !== "pending"
            ? "unavailable"
            : row.expiresAt.getTime() <= Date.now()
              ? "expired"
              : "pending",
      }
    },
    snapshot: async (access) => {
      const [family, account, people, invites] = await Promise.all([
        db
          .select({ name: organization.name })
          .from(organization)
          .where(eq(organization.id, FAMILY_ID))
          .get(),
        owner(),
        db
          .select({
            id: member.id,
            userId: user.id,
            name: user.name,
            email: user.email,
            role: member.role,
          })
          .from(member)
          .innerJoin(user, eq(member.userId, user.id))
          .where(scope)
          .orderBy(member.createdAt)
          .all(),
        access.role === "owner"
          ? db
              .select()
              .from(invitation)
              .where(
                and(
                  eq(invitation.organizationId, FAMILY_ID),
                  eq(invitation.status, "pending")
                )
              )
              .orderBy(invitation.createdAt)
              .all()
          : Promise.resolve([]),
      ])
      return {
        id: FAMILY_ID,
        name: family?.name ?? "Family",
        role: access.role,
        ownerName: account?.name ?? "Cillian",
        members: people.map((person) => ({
          ...person,
          role: person.role === "owner" ? "owner" : "member",
        })),
        invitations: invites.map((invite) => ({
          id: invite.id,
          email: invite.email,
          delivery: invite.delivery,
          status:
            invite.expiresAt.getTime() <= Date.now()
              ? "expired"
              : invite.status,
          expiresAt: invite.expiresAt.toISOString(),
        })),
      }
    },
  }
}
