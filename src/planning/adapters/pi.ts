import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import {
  defineDoc,
  defineDocFamily,
  createSession,
  type Session,
  type Storage,
  type Tx,
} from "@earendil-works/pi-durable"
import { Effect, Schema } from "effect"

import { nativeCommit } from "../../shared/adapters/native-commit"
import { orDieAll } from "../../shared/effect"
import { nativeOperation } from "../../shared/interop"
import { restorePlanBinding, restorePlanOperation } from "../authority.machine"
import {
  Plan,
  PlanFailure,
  PlanId,
  PlanReceipt,
  PlanRevision,
} from "../contracts"
import { isPlanBlocked } from "../domain"
import type { PlanLedger, PlanTransaction } from "../ledger"
import { restorePlan } from "../plan.machine"
import type { PlanAuthority, PlanEvidence } from "../plans"
import { makePlans } from "../service"

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
  version: 2,
  initial: (_: null) => ({ value: "", workflowVersion: 1 as const }),
  migrate: (raw, version) => {
    if (version !== 1) throw incompatiblePlanVersion()
    const legacy = Schema.decodeUnknownSync(LegacyDocumentRecord)(raw, {
      onExcessProperty: "error",
    })
    if (legacy.value) restorePlan(JSON.parse(legacy.value))
    return { ...legacy, workflowVersion: 1 as const }
  },
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
  version: 2,
  initial: (_: null) => ({
    planId: "",
    cancelled: false,
    workflowVersion: 1 as const,
  }),
  migrate: (raw, version) => {
    if (version !== 1) throw incompatiblePlanVersion()
    return {
      ...restorePlanBinding(
        Schema.decodeUnknownSync(LegacyBindingRecord)(raw, {
          onExcessProperty: "error",
        })
      ),
      workflowVersion: 1 as const,
    }
  },
})
const Operations = defineDocFamily({
  kind: "plans.operation",
  scope: "session",
  family: true,
  version: 2,
  initial: (_: null) => ({
    digest: "",
    receipt: "",
    workflowVersion: 1 as const,
  }),
  migrate: (raw, version) => {
    if (version !== 1) throw incompatiblePlanVersion()
    const legacy = Schema.decodeUnknownSync(LegacyOperationRecord)(raw, {
      onExcessProperty: "error",
    })
    restorePlanOperation({
      digest: legacy.digest,
      receipt: parse(PlanReceipt, legacy.receipt),
    })
    return { ...legacy, workflowVersion: 1 as const }
  },
})
const CatalogRecord = Schema.Struct({ ids: Schema.Array(PlanId) })
const LegacyDocumentRecord = Schema.Struct({ value: Schema.String })
const DocumentRecord = Schema.Struct({
  ...LegacyDocumentRecord.fields,
  workflowVersion: Schema.Number,
})
const LegacyOperationRecord = Schema.Struct({
  digest: Schema.String,
  receipt: Schema.String,
})
const OperationRecord = Schema.Struct({
  ...LegacyOperationRecord.fields,
  workflowVersion: Schema.Number,
})
const LegacyBindingRecord = Schema.Struct({
  planId: Schema.Union([Schema.Literal(""), PlanId]),
  cancelled: Schema.Boolean,
})
const BindingRecord = Schema.Struct({
  ...LegacyBindingRecord.fields,
  workflowVersion: Schema.Number,
})
const parse = <T>(schema: Schema.ConstraintDecoder<T>, value: string) => {
  const text = Schema.decodeUnknownSync(Schema.String)(value)
  return text ? Schema.decodeUnknownSync(schema)(JSON.parse(text)) : null
}

const incompatiblePlanVersion = () =>
  new PlanFailure({
    code: "unavailable",
    message:
      "This saved plan requires a compatible application version. Keep the saved data and use a compatible version before continuing.",
  })

/** Native operations can ignore abort. Join them and decode outside error conversion. */
const planRejected = (cause: unknown, channel: "failure" | "rejection") => {
  const expected = Schema.decodeUnknownOption(PlanFailure)(cause)
  if (expected._tag === "Some") return expected.value
  // The pinned Pi SDK reports document version mismatches as ordinary Errors.
  if (
    channel === "rejection" &&
    cause instanceof Error &&
    (/^Document [0-9]+ \(plans\.(?:task|turn|operation)\) has newer version [0-9]+ than 2$/.test(
      cause.message
    ) ||
      /^Document [0-9]+ \(plans\.(?:catalog|revision)\) has newer version [0-9]+ than 1$/.test(
        cause.message
      ))
  )
    return incompatiblePlanVersion()
  if (
    channel === "failure" ||
    Schema.isSchemaError(cause) ||
    cause instanceof SyntaxError
  )
    throw cause
  return new PlanFailure({
    code: "unavailable",
    message: "The saved plan could not be confirmed. Retry the same update.",
  })
}
export const planNativeOperation = <T>(
  start: (signal: AbortSignal) => Promise<T>
) => nativeOperation(start, planRejected)
// Known wrapper shapes distinguish incompatible workflow versions from corrupt data.
const planControlRecord = <T extends { workflowVersion: number }>(
  schema: Schema.ConstraintDecoder<unknown>,
  doc: T
) =>
  Effect.try({
    try: () => {
      Schema.decodeUnknownSync(schema)(doc)
      if (doc.workflowVersion !== 1) throw incompatiblePlanVersion()
      // Return Pi's tracked document, never the decoder's detached copy.
      return doc
    },
    catch: (cause) => planRejected(cause, "failure"),
  })
// Owned views translate the existing JSON strings while remaining in one commit.
const documentView = <T>(
  doc: { value: string },
  schema: Schema.ConstraintDecoder<T>,
  validate: (value: T) => T = (value) => value
) => {
  const saved = parse(schema, doc.value)
  let value = saved === null ? null : validate(saved)
  return {
    get value() {
      return value
    },
    set value(next: T | null) {
      doc.value = next === null ? "" : JSON.stringify(next)
      value = next
    },
  }
}
const transaction = <TRequirements>(
  tx: Tx,
  evidence: PlanEvidence<TRequirements>
): PlanTransaction<TRequirements> => ({
  evidence,
  catalog: () =>
    planNativeOperation(() => tx.doc(Catalog)).pipe(
      Effect.map((doc) => {
        Schema.decodeUnknownSync(CatalogRecord)(doc)
        return doc
      })
    ),
  document: (id) =>
    planNativeOperation(() => tx.doc(Documents, id, null)).pipe(
      Effect.flatMap((doc) => planControlRecord(DocumentRecord, doc)),
      Effect.map((doc) => documentView(doc, Plan, restorePlan))
    ),
  history: (key) =>
    planNativeOperation(() => tx.doc(History, key, null)).pipe(
      Effect.map((doc) => documentView(doc, PlanRevision))
    ),
  binding: (turn) =>
    planNativeOperation(() => tx.doc(Bindings, turn, null)).pipe(
      Effect.flatMap((doc) => planControlRecord(BindingRecord, doc)),
      Effect.map((doc) => {
        restorePlanBinding(doc)
        return doc
      })
    ),
  operation: (id) =>
    planNativeOperation(() => tx.doc(Operations, id, null)).pipe(
      Effect.flatMap((doc) => planControlRecord(OperationRecord, doc)),
      Effect.map((doc) => {
        let receipt = parse(PlanReceipt, doc.receipt)
        restorePlanOperation({ digest: doc.digest, receipt })
        return {
          get digest() {
            return doc.digest
          },
          set digest(value: string) {
            doc.digest = value
          },
          get receipt() {
            return receipt
          },
          set receipt(value) {
            doc.receipt = value === null ? "" : JSON.stringify(value)
            receipt = value
          },
        }
      })
    ),
})

export function piPlanLedger<TRequirements>(
  open: () => Promise<Session>,
  evidence: (tx: Tx) => PlanEvidence<TRequirements>
): PlanLedger<TRequirements> {
  const snapshot = <T>(
    read: (session: Session, signal: AbortSignal) => Promise<T>
  ) =>
    planNativeOperation(open).pipe(
      Effect.flatMap((session) =>
        planNativeOperation((signal) => read(session, signal))
      )
    )
  return {
    atomic: <T, TError, TInvocation>(
      change: (
        tx: PlanTransaction<TRequirements>
      ) => Effect.Effect<T, TError, TInvocation>
    ) =>
      planNativeOperation(open).pipe(
        Effect.flatMap((session) =>
          nativeCommit<Tx, T, TError, TInvocation, PlanFailure>(
            (body, signal) =>
              session.commit(body, { ...context, abortSignal: signal }),
            (tx) => change(transaction(tx, evidence(tx))),
            planRejected
          )
        )
      ),
    catalog: () =>
      snapshot((session, signal) =>
        session.snapshot(Catalog, { ...context, abortSignal: signal })
      ).pipe(
        Effect.map((doc) =>
          doc ? Schema.decodeUnknownSync(CatalogRecord)(doc).ids : []
        )
      ),
    binding: (turn) =>
      snapshot((session, signal) =>
        session.snapshot(Bindings, turn, { ...context, abortSignal: signal })
      ).pipe(
        Effect.flatMap((doc) =>
          doc
            ? planControlRecord(BindingRecord, doc)
            : Effect.succeed(undefined)
        )
      ),
    history: (key) =>
      snapshot((session, signal) =>
        session.snapshot(History, key, { ...context, abortSignal: signal })
      ).pipe(Effect.map((doc) => parse(PlanRevision, doc?.value ?? ""))),
  }
}
export const planDigest = (input: unknown) =>
  planNativeOperation(() =>
    crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(input))
    )
  ).pipe(
    Effect.map((bytes) =>
      Array.from(new Uint8Array(bytes), (n) =>
        n.toString(16).padStart(2, "0")
      ).join("")
    )
  )
export const piPlans = <TRequirements>(
  open: () => Promise<Session>,
  authority: PlanAuthority<TRequirements>,
  evidence: (tx: Tx) => PlanEvidence<TRequirements> = () => authority.evidence
) => makePlans(piPlanLedger(open, evidence), authority, planDigest)

export function savedPlanBlocked(
  session: Pick<Session, "snapshot">,
  turnId: string
) {
  return Effect.gen(function* () {
    const raw = yield* planNativeOperation((signal) =>
      session.snapshot(Bindings, turnId, { ...context, abortSignal: signal })
    )
    const binding = raw
      ? yield* planControlRecord(BindingRecord, raw)
      : undefined
    if (!binding?.planId || binding.cancelled) return false
    const doc = yield* planNativeOperation((signal) =>
      session.snapshot(Documents, binding.planId, {
        ...context,
        abortSignal: signal,
      })
    )
    if (doc) yield* planControlRecord(DocumentRecord, doc)
    const plan = parse(Plan, doc?.value ?? "")
    return isPlanBlocked(binding, plan ? restorePlan(plan) : null, turnId)
  })
}
export function planBlockerStatus(
  current: () => Storage | undefined,
  openReadonly: () => Promise<Storage>,
  turnId: string
) {
  return Effect.acquireUseRelease(
    Effect.suspend(() => {
      const shared = current()
      return shared
        ? Effect.succeed({ storage: shared, owned: false })
        : planNativeOperation(openReadonly).pipe(
            Effect.map((storage) => ({ storage, owned: true }))
          )
    }),
    ({ storage }) => {
      const shared = current() ?? storage
      return savedPlanBlocked(createSession(shared), turnId).pipe(
        Effect.map((blocked) =>
          current() && current() !== shared ? undefined : blocked
        )
      )
    },
    ({ storage, owned }) =>
      owned
        ? planNativeOperation(() => storage.close(context)).pipe(orDieAll)
        : Effect.void
  )
}
