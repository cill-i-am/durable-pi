import { Effect, Schema } from "effect"
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import {
  defineDoc,
  defineDocFamily,
  createSession,
  type Session,
  type Storage,
  type Tx,
} from "@earendil-works/pi-durable"
import {
  Plan,
  PlanFailure,
  PlanId,
  PlanReceipt,
  PlanRevision,
} from "../contracts"
import type { PlanAuthority, PlanEvidence } from "../plans"
import type { PlanLedger, PlanTransaction } from "../ledger"
import { isPlanBlocked } from "../domain"
import { makePlans } from "../service"
import { nativeOperation } from "../../shared/interop"
import { nativeCommit } from "../../shared/adapters/native-commit"

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
const CatalogRecord = Schema.Struct({ ids: Schema.Array(PlanId) })
const OperationRecord = Schema.Struct({
  digest: Schema.String,
  receipt: Schema.String,
})
const BindingRecord = Schema.Struct({
  planId: Schema.Union([Schema.Literal(""), PlanId]),
  cancelled: Schema.Boolean,
})
const parse = <T>(schema: Schema.ConstraintDecoder<T>, value: string) => {
  const text = Schema.decodeUnknownSync(Schema.String)(value)
  return text ? Schema.decodeUnknownSync(schema)(JSON.parse(text)) : null
}

/** Native operations can ignore abort. Join them and decode outside error conversion. */
const planRejected = (cause: unknown, channel: "failure" | "rejection") => {
  const expected = Schema.decodeUnknownOption(PlanFailure)(cause)
  if (expected._tag === "Some") return expected.value
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
// Owned views translate the existing JSON strings while remaining in one commit.
const documentView = <T>(
  doc: { value: string },
  schema: Schema.ConstraintDecoder<T>
) => {
  let value = parse(schema, doc.value)
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
      Effect.map((doc) => documentView(doc, Plan))
    ),
  history: (key) =>
    planNativeOperation(() => tx.doc(History, key, null)).pipe(
      Effect.map((doc) => documentView(doc, PlanRevision))
    ),
  binding: (turn) =>
    planNativeOperation(() => tx.doc(Bindings, turn, null)).pipe(
      Effect.map((doc) => {
        Schema.decodeUnknownSync(BindingRecord)(doc)
        return doc
      })
    ),
  operation: (id) =>
    planNativeOperation(() => tx.doc(Operations, id, null)).pipe(
      Effect.map((doc) => {
        Schema.decodeUnknownSync(OperationRecord)(doc)
        let receipt = parse(PlanReceipt, doc.receipt)
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
        Effect.map((doc) =>
          doc ? Schema.decodeUnknownSync(BindingRecord)(doc) : undefined
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
      ? Schema.decodeUnknownSync(BindingRecord)(raw)
      : undefined
    if (!binding?.planId || binding.cancelled) return false
    const doc = yield* planNativeOperation((signal) =>
      session.snapshot(Documents, binding.planId, {
        ...context,
        abortSignal: signal,
      })
    )
    return isPlanBlocked(binding, parse(Plan, doc?.value ?? ""), turnId)
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
        ? planNativeOperation(() => storage.close(context)).pipe(Effect.orDie)
        : Effect.void
  )
}
