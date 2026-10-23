import { Schema } from "effect"

import type { AccessError } from "../access/gate"
import type { ConversationError } from "../conversations/service"
import type { CoordinationFailure } from "../coordination/contracts"
import type { BackgroundError } from "../delegation/background-mailbox"
import type { CredentialUnavailable } from "../inference/credentials"
import type { RoutineError } from "../routines/service"

export const FamilyState = Schema.Struct({
  owner: Schema.String,
  modelOwner: Schema.UndefinedOr(Schema.String),
  joinedAt: Schema.Number,
  membershipId: Schema.String,
})
export type FamilyState = typeof FamilyState.Type
export type FamilyAdmissionError =
  | CredentialUnavailable
  | RoutineError
  | ConversationError
  | AccessError
  | CoordinationFailure
  | BackgroundError
export const FamilyGeneration = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  membershipId: Schema.NullOr(Schema.String),
})
export type FamilyGeneration = typeof FamilyGeneration.Type
export const FamilyObservation = Schema.Struct({
  epoch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  state: Schema.NullOr(FamilyState),
  previous: Schema.UndefinedOr(Schema.NullOr(Schema.String)),
  needsMigration: Schema.Boolean,
})
export type FamilyObservation = typeof FamilyObservation.Type
export type FamilyDecision =
  | { type: "retry" }
  | { type: "admitted"; state: FamilyState | null }

/** Keep the existing key and identity. A legacy primitive becomes a versioned
 * record only after the generation machine admits that write. */
export function readFamilyGeneration(saved: unknown) {
  if (saved === undefined) return { previous: undefined, needsMigration: false }
  if (saved === null || typeof saved === "string")
    return { previous: saved, needsMigration: true }
  return {
    previous: Schema.decodeUnknownSync(FamilyGeneration)(saved).membershipId,
    needsMigration: false,
  }
}
