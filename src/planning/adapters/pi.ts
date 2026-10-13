import { Effect, Schema } from "effect"
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import {
  defineDoc,
  defineDocFamily,
  type Session,
  type Storage,
  createSession,
  type Tx,
} from "@earendil-works/pi-durable"
import {
  Plan,
  PlanFailure,
  PlanId,
  PlanReceipt,
  PlanRevision,
  PlanUpdate,
  Revision,
  summarizePlan,
  type PlanDetail,
} from "../contracts"
import type { PlanAuthority, Plans, PlanSource } from "../plans"
import { revisePlan } from "../plan"

const Catalog = defineDoc({
  kind: "plans.catalog",
  scope: "session",
  version: 1,
  initial: () => ({ ids: [] as string[] }),
})
const Documents = defineDocFamily({
  kind: "plans.task",
  scope: "session",
  family: true,
  version: 1,
  initial: (_: null) => ({ value: "" }),
})
const History = defineDocFamily({
  kind: "plans.revision",
  scope: "session",
  family: true,
  version: 1,
  initial: (_: null) => ({ value: "" }),
})
const Bindings = defineDocFamily({
  kind: "plans.turn",
  scope: "session",
  family: true,
  version: 1,
  initial: (_: null): { planId: string; cancelled: boolean } => ({
    planId: "",
    cancelled: false,
  }),
})
const Operations = defineDocFamily({
  kind: "plans.operation",
  scope: "session",
  family: true,
  version: 1,
  initial: (_: null) => ({ digest: "", receipt: "" }),
})
const parse = (value: string) =>
  Schema.decodeUnknownSync(Plan)(JSON.parse(value))
const attempt = <T>(body: () => Promise<T>) =>
  Effect.tryPromise({
    try: body,
    catch: (cause) =>
      cause instanceof PlanFailure
        ? cause
        : new PlanFailure({
            code: "unavailable",
            message:
              "The saved plan could not be confirmed. Retry the same update.",
          }),
  })
const decode = <T>(body: () => T) => {
  try {
    return body()
  } catch {
    throw new PlanFailure({
      code: "invalid",
      message: "Check the plan fields, step IDs and revisions.",
    })
  }
}
const missing = () =>
  new PlanFailure({
    code: "not_found",
    message: "This task is unavailable in this bot.",
  })
const fingerprint = async (input: unknown) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(input))
      )
    ),
    (n) => n.toString(16).padStart(2, "0")
  ).join("")

/** Native document snapshots only: no harness opening, resume or evidence reconciliation. */
export function savedPlanBlocked(
  session: Pick<Session, "snapshot">,
  turnId: string
) {
  return attempt(async () => {
    const binding = await session.snapshot(Bindings, turnId, context)
    if (!binding?.planId || binding.cancelled) return false
    const document = await session.snapshot(Documents, binding.planId, context)
    if (!document?.value) return false
    const plan = parse(document.value)
    return (
      plan.rootTurns.includes(turnId) &&
      plan.state === "open" &&
      !!plan.blocker.trim()
    )
  })
}

/** The bridge owns warm storage. A cold status read owns only its disposable facade. */
export function planBlockerStatus(
  current: () => Storage | undefined,
  openReadonly: () => Promise<Storage>,
  turnId: string
) {
  return Effect.acquireUseRelease(
    attempt(async () => {
      const shared = current()
      return { storage: shared ?? (await openReadonly()), owned: !shared }
    }),
    ({ storage }) => {
      const shared = current() ?? storage
      return savedPlanBlocked(createSession(shared), turnId).pipe(
        // A native startup can replace a cold reader's facade while it awaits.
        // Discard that view; the next status read uses the bridge's commit queue.
        Effect.map((blocked) =>
          current() && current() !== shared ? undefined : blocked
        )
      )
    },
    ({ storage, owned }) =>
      owned ? Effect.promise(() => storage.close(context)) : Effect.void
  )
}

/** Native atomic documents own plan state, history, turn bindings and retry receipts together. */
export function piPlans(
  open: () => Promise<Session>,
  authority: PlanAuthority,
  transactionEvidence: (tx: Tx) => PlanAuthority["evidence"] = () =>
    authority.evidence
): Plans {
  const writable = (source: PlanSource, replay = false) => {
    const current = authority.current(source.turnId)
    if (!current)
      throw new PlanFailure({
        code: "cancelled",
        message: "This run has stopped. A saved plan cannot resume it.",
      })
    if (
      !replay &&
      (current.pendingInputs ||
        current.inputRevision !== source.inputRevision ||
        JSON.stringify(current.inputIds) !== JSON.stringify(source.inputIds))
    )
      throw new PlanFailure({
        code: "conflict",
        message:
          "New user input arrived. Read the current input revision and revise the plan before continuing.",
      })
  }
  const reconcile = (id: string) =>
    attempt(async () => {
      const session = await open()
      return session.commit(async (tx) => {
        const doc = await tx.doc(Documents, id, null)
        if (!doc.value) throw missing()
        const saved = parse(doc.value)
        if (saved.state === "cancelled") return saved
        let cancelled = saved.rootTurns.some(authority.cancelled)
        for (const root of saved.rootTurns)
          if ((await tx.doc(Bindings, root, null)).cancelled) cancelled = true
        let changed = false
        const steps = []
        for (const step of saved.steps) {
          const evidence = []
          for (const ref of step.evidence)
            evidence.push(
              cancelled
                ? ref
                : await Effect.runPromise(
                    transactionEvidence(tx)(ref, saved.rootTurns)
                  )
            )
          const invalid = evidence.some((ref) => ref.state === "invalid")
          const next = {
            ...step,
            evidence,
            status:
              invalid && step.status === "completed"
                ? ("pending" as const)
                : step.status,
          }
          if (JSON.stringify(next) !== JSON.stringify(step)) changed = true
          steps.push(next)
        }
        if (!cancelled && !changed) return saved
        const reopened = steps.some(
          (step, i) => step.status !== saved.steps[i]!.status
        )
        const next: Plan = {
          ...saved,
          steps,
          revision: saved.revision + 1,
          updatedAt: new Date().toISOString(),
          state: cancelled ? "cancelled" : reopened ? "open" : saved.state,
          complete: cancelled || reopened ? false : saved.complete,
          nextAction: cancelled
            ? ""
            : reopened
              ? "Reassess the reopened steps; their evidence is no longer current."
              : saved.nextAction,
          blocker: cancelled
            ? "Stopped by the user or run lifecycle."
            : saved.blocker,
        }
        const history = await tx.doc(History, `${id}:${next.revision}`, null)
        history.value = JSON.stringify({
          plan: next,
          actor: "system",
          reason: cancelled ? "Run cancelled" : "Evidence revalidated",
          turnId: null,
        } satisfies PlanRevision)
        doc.value = JSON.stringify(next)
        return next
      }, context)
    })
  const list = (offset = 0, limit = 20) =>
    Effect.gen(function* () {
      const ids = yield* attempt(
        async () => (await (await open()).snapshot(Catalog, context))?.ids ?? []
      )
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
    read: (raw, before) =>
      Effect.gen(function* () {
        const id = yield* attempt(async () =>
          decode(() => Schema.decodeUnknownSync(PlanId)(raw))
        )
        const plan = yield* reconcile(id)
        return yield* attempt(async (): Promise<PlanDetail> => {
          if (before !== undefined)
            decode(() => Schema.decodeUnknownSync(Revision)(before))
          const session = await open(),
            from = Math.min(
              plan.revision,
              before === undefined ? plan.revision : before - 1
            )
          const history: PlanRevision[] = []
          for (
            let revision = from;
            revision > Math.max(0, from - 10);
            revision--
          ) {
            const value = (
              await session.snapshot(History, `${id}:${revision}`, context)
            )?.value
            if (value)
              history.push(
                Schema.decodeUnknownSync(PlanRevision)(JSON.parse(value))
              )
          }
          return { plan, history, nextHistory: from > 10 ? from - 9 : null }
        })
      }),
    update: (raw, source) =>
      attempt(async () => {
        const input = decode(() => Schema.decodeUnknownSync(PlanUpdate)(raw)),
          digest = await fingerprint({ input, source }),
          session = await open()
        if (source.inputRevision !== input.inputRevision)
          throw new PlanFailure({
            code: "conflict",
            message:
              "Read the current input revision before updating this plan.",
          })
        return session.commit(async (tx) => {
          writable(source, true)
          const binding = await tx.doc(Bindings, source.turnId, null)
          if (binding.cancelled)
            throw new PlanFailure({
              code: "cancelled",
              message: "This run was cancelled.",
            })
          if (binding.planId && binding.planId !== input.id)
            throw new PlanFailure({
              code: "conflict",
              message: "This run already belongs to a different logical task.",
            })
          const operation = await tx.doc(Operations, input.operationId, null)
          if (operation.receipt) {
            if (operation.digest !== digest)
              throw new PlanFailure({
                code: "conflict",
                message: "This tool operation belongs to another update.",
              })
            return Schema.decodeUnknownSync(PlanReceipt)(
              JSON.parse(operation.receipt)
            )
          }
          writable(source)
          const catalog = await tx.doc(Catalog),
            doc = await tx.doc(Documents, input.id, null),
            previous = doc.value ? parse(doc.value) : null
          if (
            (!previous && catalog.ids.length >= 200) ||
            (previous &&
              (previous.revision >= 1000 || previous.rootTurns.length >= 100))
          )
            throw new PlanFailure({
              code: "limit",
              message:
                "This task has reached its plan history limit. Start a new task when the user requests new work.",
            })
          if (previous?.rootTurns.some(authority.cancelled))
            throw new PlanFailure({
              code: "cancelled",
              message:
                "This task was cancelled. Do not resume it from its saved plan.",
            })
          const roots = [...(previous?.rootTurns ?? []), source.turnId],
            evidence = []
          for (const step of input.draft.steps)
            for (const ref of step.evidence)
              evidence.push(
                await Effect.runPromise(transactionEvidence(tx)(ref, roots))
              )
          // Reject invented, foreign or stale references instead of laundering them into completion.
          if (evidence.some((ref) => ref.state !== "valid"))
            throw new PlanFailure({
              code: "invalid",
              message:
                "An evidence reference is unavailable, stale or unsuccessful. Inspect the source before revising the plan.",
            })
          const next = revisePlan(
            previous,
            input,
            source,
            evidence,
            new Date().toISOString()
          )
          const history = await tx.doc(
            History,
            `${input.id}:${next.revision}`,
            null
          )
          writable(source)
          history.value = JSON.stringify({
            plan: next,
            actor: "agent",
            reason: input.reason,
            turnId: source.turnId,
          } satisfies PlanRevision)
          doc.value = JSON.stringify(next)
          binding.planId = next.id
          if (!previous) catalog.ids.push(next.id)
          const receipt: PlanReceipt = {
            id: next.id,
            revision: next.revision,
            state: next.state,
            reopened: next.steps
              .filter((step, i) => step.status !== input.draft.steps[i]!.status)
              .map((step) => step.id),
          }
          operation.digest = digest
          operation.receipt = JSON.stringify(receipt)
          return receipt
        }, context)
      }),
    cancel: (turnId) =>
      Effect.gen(function* () {
        const id = yield* attempt(async () =>
          (await open()).commit(async (tx) => {
            const binding = await tx.doc(Bindings, turnId, null)
            binding.cancelled = true
            return binding.planId
          }, context)
        )
        if (id) yield* reconcile(id)
      }),
    context: (source) =>
      Effect.gen(function* () {
        const binding = yield* attempt(
          async () =>
            (await (await open()).snapshot(Bindings, source.turnId, context))
              ?.planId
        )
        const current = binding ? yield* reconcile(binding) : null
        return {
          current,
          recent: current ? [] : yield* list(0, 8),
          receipts: authority.receipts(current?.rootTurns ?? [source.turnId]),
        }
      }),
  }
}
