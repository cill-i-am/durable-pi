import type { Model } from "@earendil-works/pi-ai"
import type {
  CompactionPolicy,
  HarnessSettings,
} from "@earendil-works/pi-durable"

/** Working context only. OptChat continues to own the original transcript. */
export function workingContextPolicy(
  model: Pick<Model<string>, "contextWindow" | "maxTokens">
): CompactionPolicy {
  const window = model.contextWindow
  if (!Number.isFinite(window) || window < 4)
    throw new Error("The selected model has no usable context budget")
  // Reasoning shares the response budget. Do not silently assume a small answer.
  const output = model.maxTokens > 0 ? model.maxTokens : Math.floor(window / 2)
  // One ordinary large tool result plus ephemeral references/estimation error.
  // This is headroom, not a guarantee that an arbitrary single input will fit.
  const headroom = Math.min(32_000, Math.ceil(window / 8))
  const reserveTokens = Math.min(Math.floor(window * 0.75), output + headroom)
  return {
    enabled: true,
    reserveTokens,
    keepRecentTokens: Math.min(
      20_000,
      Math.floor((window - reserveTokens) / 3)
    ),
    // A compaction belongs to the active run and finishes before its next request.
    // No background summary can outlive that run and borrow a later model's policy.
    backgroundTokens: 0,
  }
}

/** Resolve on every native policy read, including recovery, from the pinned run. */
export function agentSettings(
  model: () => Pick<Model<string>, "contextWindow" | "maxTokens"> | undefined
): HarnessSettings {
  return {
    retry: { enabled: true, maxRetries: 3, baseDelayMs: 1000 },
    get compaction() {
      const selected = model()
      if (!selected) throw new Error("The selected model is unavailable")
      return workingContextPolicy(selected)
    },
  }
}
