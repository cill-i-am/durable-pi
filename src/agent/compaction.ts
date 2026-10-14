import type { Model } from "@earendil-works/pi-ai"
import type {
  CompactionPolicy,
  HarnessSettings,
} from "@earendil-works/pi-durable"

export function contextProjectionBytes(contextWindow: number) {
  if (!Number.isFinite(contextWindow) || contextWindow < 4)
    throw new Error("The selected model has no usable context budget")
  return Math.min(8192, Math.floor(contextWindow / 32))
}

export function workingContextPolicy(
  model: Pick<Model<string>, "contextWindow" | "maxTokens">
): CompactionPolicy {
  const window = model.contextWindow
  if (!Number.isFinite(window) || window < 4)
    throw new Error("The selected model has no usable context budget")
  const output = model.maxTokens > 0 ? model.maxTokens : Math.floor(window / 2)
  const headroom = Math.min(32_000, Math.ceil(window / 8))
  const reserveTokens = Math.min(Math.floor(window * 0.75), output + headroom)
  return {
    enabled: true,
    reserveTokens,
    keepRecentTokens: Math.min(
      20_000,
      Math.floor((window - reserveTokens) / 3)
    ),
    backgroundTokens: 0,
  }
}

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
