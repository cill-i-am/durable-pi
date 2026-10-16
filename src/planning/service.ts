import { Clock, Context, Effect, Layer, Schema } from "effect"
import {
  PlanFailure,
  PlanId,
  PlanUpdate,
  Revision,
  summarizePlan,
  type PlanRevision,
  type Evidence,
  type PlanReceipt,
} from "./contracts"
import type { PlanControl, PlanSource, Plans } from "./plans"
import type { PlanBinding, PlanDigest, PlanLedger } from "./ledger"
import { revisePlan } from "./plan"
import {
  planHistoryKey,
  planReplay,
  reconcilePlan,
  requirePlanBinding,
  requirePlanCapacity,
  requirePlanEvidence,
  requirePlanInputRevision,
  requirePlanWritable,
  requireUncancelledPlan,
} from "./domain"

export class Planning extends Context.Service<Planning, Plans>()(
  "durable-pi/planning/Planning"
) {}
const decode = <T>(schema: Schema.ConstraintDecoder<T>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      () =>
        new PlanFailure({
          code: "invalid",
          message: "Check the plan fields, step IDs and revisions.",
        })
    )
  )
const decision = <T>(body: () => T) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      const planFailure = Schema.decodeUnknownOption(PlanFailure)(cause)
      if (planFailure._tag === "Some") return planFailure.value
      throw cause
    },
  })
const timestamp = Clock.currentTimeMillis.pipe(
  Effect.map((now) => new Date(now).toISOString())
)

export function makePlans<TRequirements>(
  ledger: PlanLedger<TRequirements>,
  authority: PlanControl,
  digest: PlanDigest
): Plans<TRequirements> {
  const writable = (source: PlanSource, replay = false) =>
    authority
      .current(source.turnId)
      .pipe(
        Effect.flatMap((current) =>
          decision(() => requirePlanWritable(current, source, replay))
        )
      )
  const reconcile = Effect.fn("Planning.reconcile")((id: string) =>
    ledger.atomic((tx) =>
      Effect.gen(function* () {
        const doc = yield* tx.document(id)
        const saved = doc.value
        if (!saved)
          return yield* new PlanFailure({
            code: "not_found",
            message: "This task is unavailable in this bot.",
          })
        if (saved.state === "cancelled") return saved
        const bindings: PlanBinding[] = []
        for (const root of saved.rootTurns)
          bindings.push(yield* tx.binding(root))
        const cancelled = () =>
          Effect.forEach(saved.rootTurns, (root) =>
            authority.cancelled(root)
          ).pipe(
            Effect.map(
              (values) =>
                bindings.some((entry) => entry.cancelled) ||
                values.some(Boolean)
            )
          )
        const alreadyCancelled = yield* cancelled()
        const evidence: Evidence[][] = []
        for (const step of saved.steps) {
          const refs: Evidence[] = []
          for (const ref of step.evidence)
            refs.push(
              alreadyCancelled ? ref : yield* tx.evidence(ref, saved.rootTurns)
            )
          evidence.push(refs)
        }
        const now = yield* timestamp
        const next = reconcilePlan(saved, evidence, yield* cancelled(), now)
        if (!next) return saved
        const history = yield* tx.history(planHistoryKey(id, next.revision))
        const finalCancelled = yield* cancelled()
        return yield* Effect.sync(() => {
          const final = reconcilePlan(saved, evidence, finalCancelled, now)
          if (!final) return saved
          history.value = {
            plan: final,
            actor: "system",
            reason:
              final.state === "cancelled"
                ? "Run cancelled"
                : "Evidence revalidated",
            turnId: null,
          }
          doc.value = final
          return final
        })
      })
    )
  )
  const list = Effect.fn("Planning.list")(function* (offset = 0, limit = 20) {
    yield* decode(Revision, offset)
    yield* decode(Revision, limit)
    const ids = yield* ledger.catalog()
    const values = []
    for (const id of ids
      .slice()
      .reverse()
      .slice(offset, offset + limit))
      values.push(summarizePlan(yield* reconcile(id)))
    return values
  })
  return {
    list,
    read: Effect.fn("Planning.read")(function* (raw, before) {
      const id = yield* decode(PlanId, raw)
      if (before !== undefined) yield* decode(Revision, before)
      const plan = yield* reconcile(id)
      const from = Math.min(
        plan.revision,
        before === undefined ? plan.revision : before - 1
      )
      const history: PlanRevision[] = []
      for (let revision = from; revision > Math.max(0, from - 10); revision--) {
        const value = yield* ledger.history(planHistoryKey(id, revision))
        if (value) history.push(value)
      }
      return { plan, history, nextHistory: from > 10 ? from - 9 : null }
    }),
    update: Effect.fn("Planning.update")(function* (raw, source) {
      const input = yield* decode(PlanUpdate, raw)
      const fingerprint = yield* digest({ input, source })
      yield* decision(() => requirePlanInputRevision(input, source))
      return yield* ledger.atomic((tx) =>
        Effect.gen(function* () {
          yield* writable(source, true)
          const binding = yield* tx.binding(source.turnId)
          yield* decision(() => requirePlanBinding(binding, input.id))
          const operation = yield* tx.operation(input.operationId)
          const replay = yield* decision(() =>
            planReplay(operation, fingerprint)
          )
          if (replay) return replay
          yield* writable(source)
          const catalog = yield* tx.catalog(),
            doc = yield* tx.document(input.id),
            previous = doc.value
          yield* decision(() =>
            requirePlanCapacity(previous, catalog.ids.length)
          )
          const bindings: PlanBinding[] = []
          for (const root of previous?.rootTurns ?? [])
            bindings.push(yield* tx.binding(root))
          const cancelled = () =>
            Effect.forEach(previous?.rootTurns ?? [], (root) =>
              authority.cancelled(root)
            ).pipe(
              Effect.map(
                (values) =>
                  bindings.some((entry) => entry.cancelled) ||
                  values.some(Boolean)
              )
            )
          const wasCancelled = yield* cancelled()
          yield* decision(() => requireUncancelledPlan(wasCancelled))
          const roots = [...(previous?.rootTurns ?? []), source.turnId],
            evidence: Evidence[] = []
          for (const step of input.draft.steps)
            for (const ref of step.evidence)
              evidence.push(yield* tx.evidence(ref, roots))
          yield* decision(() => requirePlanEvidence(evidence))
          const now = yield* timestamp
          const next = yield* decision(() =>
            revisePlan(previous, input, source, evidence, now)
          )
          const history = yield* tx.history(
            planHistoryKey(input.id, next.revision)
          )
          yield* writable(source)
          const finallyCancelled = yield* cancelled()
          return yield* decision(() => {
            requireUncancelledPlan(finallyCancelled)
            history.value = {
              plan: next,
              actor: "agent",
              reason: input.reason,
              turnId: source.turnId,
            }
            doc.value = next
            binding.planId = next.id
            if (!previous) catalog.ids.push(next.id)
            const receipt: PlanReceipt = {
              id: next.id,
              revision: next.revision,
              state: next.state,
              reopened: next.steps
                .filter(
                  (step, i) => step.status !== input.draft.steps[i]!.status
                )
                .map((step) => step.id),
            }
            operation.digest = fingerprint
            operation.receipt = receipt
            return receipt
          })
        })
      )
    }),
    cancel: Effect.fn("Planning.cancel")(function* (turnId) {
      const id = yield* ledger.atomic((tx) =>
        tx.binding(turnId).pipe(
          Effect.map((binding) => {
            binding.cancelled = true
            return binding.planId
          })
        )
      )
      if (id) yield* reconcile(id)
    }),
    context: Effect.fn("Planning.context")(function* (source) {
      const binding = yield* ledger.binding(source.turnId)
      const current = binding?.planId ? yield* reconcile(binding.planId) : null
      return {
        current,
        recent: current ? [] : yield* list(0, 8),
        receipts: yield* authority.receipts(
          current?.rootTurns ?? [source.turnId]
        ),
      }
    }),
  }
}
export const planningApplication = (
  ledger: PlanLedger,
  authority: PlanControl,
  digest: PlanDigest
) => Layer.succeed(Planning, makePlans(ledger, authority, digest))
