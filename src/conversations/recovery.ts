import { Schema } from "effect"

const counter = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const RecoveryView = Schema.Struct({
  phase: Schema.Literals(["recovering", "recovered", "blocked"]),
  reason: Schema.Literals(["repetition", "denied", "uncertain"]),
  tool: Schema.String,
  failures: counter,
  remaining: counter,
  resultId: counter,
  receiptId: Schema.NullOr(Schema.String),
  detail: Schema.String,
})
export type RecoveryView = {
  -readonly [K in keyof typeof RecoveryView.Type]: (typeof RecoveryView.Type)[K]
}
export class RunBlocked extends Schema.TaggedError<RunBlocked>()("RunBlocked", {
  message: Schema.String,
}) {}
export type RecoveryPolicy = {
  warnAfter: number
  stopAfter: number
  recoveryAttempts: number
}
export const recoveryPolicy: RecoveryPolicy = {
  warnAfter: 3,
  stopAfter: 5,
  recoveryAttempts: 3,
}
export const ObservationRecord = Schema.Struct({
  resultId: counter,
  invocation: Schema.String,
  tool: Schema.String,
  fingerprint: Schema.String,
  outcome: Schema.Literals([
    "failure",
    "success",
    "poll",
    "ignored",
    "denied",
    "uncertain",
  ]),
  receiptId: Schema.NullOr(Schema.String),
})
export type Observation = {
  resultId: number
  invocation: string
  tool: string
  fingerprint: string
  outcome: "failure" | "success" | "poll" | "ignored" | "denied" | "uncertain"
  receiptId: string | null
}
export type RecoveryState = {
  version: 1
  workflowVersion: 1
  epoch: string
  cursor: number
  buckets: { fingerprint: string; count: number }[]
  view: RecoveryView | null
}
export const RecoveryStateRecord = Schema.Struct({
  version: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  epoch: Schema.String,
  cursor: counter,
  buckets: Schema.Array(
    Schema.Struct({ fingerprint: Schema.String, count: counter })
  ),
  view: Schema.NullOr(RecoveryView),
})
export function requireRecoveryPolicy(policy: RecoveryPolicy) {
  if (
    !Number.isInteger(policy.warnAfter) ||
    policy.warnAfter < 2 ||
    !Number.isInteger(policy.stopAfter) ||
    policy.stopAfter <= policy.warnAfter ||
    !Number.isInteger(policy.recoveryAttempts) ||
    policy.recoveryAttempts < 1
  )
    throw new Error("Invalid tool recovery policy")
}
export const canObserveRecovery = (
  turn: { status: string; session_id: string | null } | undefined,
  session: string
) =>
  !!turn &&
  turn.session_id === session &&
  ["preparing", "running"].includes(turn.status)
export function recoveryOutcome(input: {
  receiptStatus?: string
  diagnostics: readonly string[]
  isError: boolean
  tool: string
  deniedPolicy: boolean
}): { outcome: Observation["outcome"]; category: string } {
  const { receiptStatus, diagnostics, isError, tool, deniedPolicy } = input
  if (receiptStatus && ["running", "interrupted"].includes(receiptStatus))
    return { outcome: "uncertain", category: "tool_error" }
  if (receiptStatus && ["denied", "expired"].includes(receiptStatus))
    return { outcome: "denied", category: "tool_error" }
  if (
    receiptStatus &&
    ["pending", "approved", "cancelled"].includes(receiptStatus)
  )
    return { outcome: "ignored", category: "tool_error" }
  if (diagnostics.includes("interrupted"))
    return { outcome: "uncertain", category: "tool_error" }
  if (diagnostics.includes("blocked"))
    return { outcome: "denied", category: "tool_error" }
  if (diagnostics.includes("aborted"))
    return { outcome: "ignored", category: "tool_error" }
  if (!isError)
    return {
      outcome: tool === "check_bot_task" ? "poll" : "success",
      category: "tool_error",
    }
  if (!receiptStatus && deniedPolicy)
    return { outcome: "denied", category: "tool_error" }
  return {
    outcome: "failure",
    category: diagnostics.includes("invalid_arguments")
      ? "invalid_arguments"
      : diagnostics.includes("tool_unavailable")
        ? "tool_unavailable"
        : "tool_error",
  }
}
export const initialRecovery = (epoch: string): RecoveryState => ({
  version: 1,
  workflowVersion: 1,
  epoch,
  cursor: 0,
  buckets: [],
  view: null,
})

export function recoveryDetail(view: Omit<RecoveryView, "detail">): string {
  if (view.reason === "denied")
    return "Tool access was denied or expired. Work stopped. Review access or revise the request; do not try another tool to bypass the denial."
  if (view.reason === "uncertain")
    return "A tool may have acted without a confirmed result. Work stopped. Reconcile the saved execution receipt and external state before attempting the action again."
  if (view.phase === "blocked")
    return "Repeated tool failures exhausted recovery. Progress is saved. Inspect the failed call and correct its inputs or the underlying problem before starting a new request."
  if (view.phase === "recovered")
    return "A tool succeeded after recovery feedback. This is execution progress, not proof that the whole request is complete."
  return "The same tool and inputs repeatedly failed. Inspect the saved error, correct the inputs or use another permitted approach. Do not repeat an external action whose outcome is uncertain."
}

export function recoveryIdentity(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, x]) => [k, canonical(x)])
          )
        : v
  return JSON.stringify(canonical(value)) || ""
}

/** Version 1 historically had no workflow marker. Conversion preserves all
 * receipt/cursor/history metadata; the next observation persists it atomically. */
export function decodeRecoveryState(raw: unknown): RecoveryState {
  const historical = Schema.decodeUnknownSync(
    Schema.Record(Schema.String, Schema.Unknown)
  )(raw)
  const decoded = Schema.decodeUnknownSync(RecoveryStateRecord)({
    ...historical,
    workflowVersion: Object.hasOwn(historical, "workflowVersion")
      ? historical.workflowVersion
      : 1,
  })
  if (
    decoded.buckets.length > 32 ||
    new Set(decoded.buckets.map((bucket) => bucket.fingerprint)).size !==
      decoded.buckets.length ||
    (decoded.view &&
      (decoded.view.resultId > decoded.cursor ||
        (decoded.view.reason !== "repetition" &&
          decoded.view.phase !== "blocked")))
  )
    throw new Error("Invalid tool recovery state")
  return {
    ...historical,
    ...decoded,
    buckets: decoded.buckets.map((bucket) => ({ ...bucket })),
    view: decoded.view ? { ...decoded.view } : null,
  }
}
