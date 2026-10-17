import { Schema } from "effect"

export const FAMILY_ID = "family"
export const FamilyRole = Schema.Literals(["owner", "member"])
export const FamilyMember = Schema.Struct({
  id: Schema.String,
  userId: Schema.String,
  name: Schema.String,
  email: Schema.String,
  role: FamilyRole,
})
export const FamilyInvitation = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  expiresAt: Schema.String,
  status: Schema.String,
  delivery: Schema.String,
})
export const FamilySnapshot = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  role: FamilyRole,
  ownerName: Schema.String,
  members: Schema.Array(FamilyMember),
  invitations: Schema.Array(FamilyInvitation),
})
export type FamilySnapshot = typeof FamilySnapshot.Type
export const InvitationPreview = Schema.Struct({
  email: Schema.String,
  familyName: Schema.String,
  inviterName: Schema.String,
  status: Schema.Literals(["pending", "expired", "unavailable"]),
})
export type InvitationPreview = typeof InvitationPreview.Type

const identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200)
)
export const FamilyAction = Schema.Union([
  Schema.Struct({ action: Schema.Literal("read") }),
  Schema.Struct({
    action: Schema.Literal("invite"),
    email: Schema.String.check(
      Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
      Schema.isMaxLength(254)
    ),
  }),
  Schema.Struct({ action: Schema.Literal("resend"), invitationId: identifier }),
  Schema.Struct({ action: Schema.Literal("cancel"), invitationId: identifier }),
  Schema.Struct({ action: Schema.Literal("remove"), memberId: identifier }),
])
export type FamilyAction = typeof FamilyAction.Type
export class FamilyActionFailed extends Schema.TaggedError<FamilyActionFailed>()(
  "FamilyActionFailed",
  { message: Schema.String }
) {}
