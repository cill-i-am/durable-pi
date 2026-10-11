import { Schema } from "effect"

export const PlanId = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/i))
const text = (max: number) => Schema.String.check(Schema.isMaxLength(max))
const label = (max: number) =>
  text(max).check(Schema.isMinLength(1), Schema.isPattern(/\S/))
export const Revision = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
)
export const EvidenceRef = Schema.Struct({
  kind: Schema.Literals(["receipt", "execution", "object", "app", "file"]),
  id: label(100),
  revision: Revision,
})
export type EvidenceRef = typeof EvidenceRef.Type
export const Evidence = Schema.Struct({
  ...EvidenceRef.fields,
  state: Schema.Literals(["valid", "invalid"]),
  detail: text(500),
})
export type Evidence = typeof Evidence.Type
export const StepInput = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,39}$/)),
  title: label(240),
  status: Schema.Literals(["pending", "active", "blocked", "completed"]),
  evidence: Schema.Array(EvidenceRef).check(Schema.isMaxLength(5)),
  note: text(1000),
})
export const PlanDraft = Schema.Struct({
  objective: label(1000),
  constraints: Schema.Array(label(500)).check(Schema.isMaxLength(10)),
  criteria: Schema.Array(label(500)).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(10)
  ),
  steps: Schema.Array(StepInput).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20)
  ),
  nextAction: text(1000),
  blocker: text(1000),
  complete: Schema.Boolean,
}).check(
  Schema.makeFilter(
    (draft) =>
      new Set(draft.steps.map((step) => step.id)).size === draft.steps.length &&
      draft.steps.filter((step) => step.status === "active").length <= 1 &&
      draft.steps.reduce((count, step) => count + step.evidence.length, 0) <=
        20 &&
      (!draft.complete ||
        (draft.steps.every((step) => step.status === "completed") &&
          !draft.nextAction &&
          !draft.blocker)) &&
      (!draft.steps.some((step) => step.status === "blocked") ||
        !!draft.blocker.trim())
  )
)
export type PlanDraft = typeof PlanDraft.Type
export const PlanStep = Schema.Struct({
  ...StepInput.fields,
  evidence: Schema.Array(Evidence),
})
export const Plan = Schema.Struct({
  ...PlanDraft.fields,
  steps: Schema.Array(PlanStep),
  id: PlanId,
  schemaVersion: Schema.Literal(1),
  revision: Revision,
  state: Schema.Literals(["open", "completed", "cancelled"]),
  rootTurns: Schema.Array(PlanId),
  inputIds: Schema.Array(PlanId),
  reviewedTurn: PlanId,
  inputRevision: Revision,
  createdAt: Schema.String,
  updatedAt: Schema.String,
})
export type Plan = typeof Plan.Type
export const PlanSummary = Schema.Struct({
  id: PlanId,
  objective: Schema.String,
  revision: Revision,
  state: Plan.fields.state,
  completed: Revision,
  total: Revision,
  blocker: Schema.String,
  updatedAt: Schema.String,
})
export type PlanSummary = typeof PlanSummary.Type
export const PlanRevision = Schema.Struct({
  plan: Plan,
  actor: Schema.Literals(["agent", "system"]),
  reason: Schema.String,
  turnId: Schema.NullOr(PlanId),
})
export type PlanRevision = typeof PlanRevision.Type
export const PlanDetail = Schema.Struct({
  plan: Plan,
  history: Schema.Array(PlanRevision),
  nextHistory: Schema.NullOr(Revision),
})
export type PlanDetail = typeof PlanDetail.Type
export const PlanList = Schema.Struct({
  plans: Schema.Array(PlanSummary),
  nextOffset: Schema.NullOr(Revision),
})
export const PlanUpdate = Schema.Struct({
  id: PlanId,
  operationId: Schema.String.check(Schema.isPattern(/^tool:[0-9]+$/)),
  relation: Schema.Literals(["new", "continue"]),
  expectedRevision: Revision,
  inputRevision: Revision,
  reason: label(500),
  draft: PlanDraft,
})
export type PlanUpdate = typeof PlanUpdate.Type
export const PlanReceipt = Schema.Struct({
  id: PlanId,
  revision: Revision,
  state: Plan.fields.state,
  reopened: Schema.Array(Schema.String),
})
export type PlanReceipt = typeof PlanReceipt.Type
export class PlanFailure extends Schema.TaggedError<PlanFailure>()(
  "PlanFailure",
  {
    code: Schema.Literals([
      "invalid",
      "conflict",
      "not_found",
      "cancelled",
      "unavailable",
      "limit",
    ]),
    message: Schema.String,
  }
) {}
export const summarizePlan = (plan: Plan): PlanSummary => ({
  id: plan.id,
  objective: plan.objective,
  revision: plan.revision,
  state: plan.state,
  completed: plan.steps.filter((step) => step.status === "completed").length,
  total: plan.steps.length,
  blocker: plan.blocker,
  updatedAt: plan.updatedAt,
})
