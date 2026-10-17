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
  epoch: string
  cursor: number
  buckets: { fingerprint: string; count: number }[]
  view: RecoveryView | null
}
export const RecoveryStateRecord = Schema.Struct({
  version: Schema.Literal(1),
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

export function observeRound(
  saved: RecoveryState,
  epoch: string,
  requestEpoch: string,
  observations: readonly Observation[],
  policy: RecoveryPolicy = recoveryPolicy
): RecoveryState {
  if (saved.view?.phase === "blocked") return saved
  const state: RecoveryState = structuredClone(saved)
  if (state.epoch !== epoch) {
    state.epoch = epoch
    state.buckets = []
    state.view = null
  }
  const seen = new Set<string>()
  const fresh = [...observations]
    .sort((a, b) => a.resultId - b.resultId)
    .filter((o) => {
      if (o.resultId <= saved.cursor || seen.has(o.invocation)) return false
      seen.add(o.invocation)
      return true
    })
  state.cursor = Math.max(state.cursor, ...observations.map((o) => o.resultId))
  const authority =
    fresh.find((o) => o.outcome === "uncertain") ??
    fresh.find((o) => o.outcome === "denied")
  if (authority) {
    const view = {
      phase: "blocked" as const,
      reason: authority.outcome as "denied" | "uncertain",
      tool: authority.tool,
      failures: 0,
      remaining: 0,
      resultId: authority.resultId,
      receiptId: authority.receiptId,
    }
    state.view = { ...view, detail: recoveryDetail(view) }
    return state
  }
  const wasRecovering = state.view?.phase === "recovering"
  let recovered = false
  for (const o of fresh) {
    if (
      requestEpoch !== epoch ||
      o.outcome === "ignored" ||
      o.outcome === "poll"
    )
      continue
    if (wasRecovering && state.view)
      state.view.remaining = Math.max(0, state.view.remaining - 1)
    if (o.outcome === "success") {
      recovered = true
      continue
    }
    if (observeFailure(state, o, policy, wasRecovering)) break
  }
  finalizeRecovery(state, wasRecovering, recovered)
  return state
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

function observeFailure(
  state: RecoveryState,
  o: Observation,
  policy: RecoveryPolicy,
  wasRecovering: boolean
) {
  let bucket = state.buckets.find((b) => b.fingerprint === o.fingerprint)
  if (!bucket) {
    bucket = { fingerprint: o.fingerprint, count: 0 }
    state.buckets.push(bucket)
    if (state.buckets.length > 32) state.buckets.shift()
  }
  bucket.count = Math.min(policy.stopAfter, bucket.count + 1)
  if (bucket.count >= policy.warnAfter) {
    const view = {
      phase: "recovering" as const,
      reason: "repetition" as const,
      tool: o.tool,
      failures: bucket.count,
      remaining: wasRecovering
        ? state.view!.remaining
        : policy.recoveryAttempts,
      resultId: o.resultId,
      receiptId: o.receiptId,
    }
    state.view = { ...view, detail: recoveryDetail(view) }
    if (wasRecovering && bucket.count >= policy.stopAfter) {
      state.view.phase = "blocked"
      return true
    }
  }
  return false
}

function finalizeRecovery(
  state: RecoveryState,
  wasRecovering: boolean,
  recovered: boolean
) {
  if (wasRecovering && state.view?.phase === "recovering") {
    if (recovered) state.view.phase = "recovered"
    else if (state.view.remaining === 0) state.view.phase = "blocked"
  }
  if (state.view) state.view.detail = recoveryDetail(state.view)
}
