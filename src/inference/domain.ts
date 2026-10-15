import type { ModelCapability, ModelCatalog } from "./policy"
import type { ThinkingLevel } from "./selection"

export interface CatalogCandidate {
  id: string
  name: string
  visible: boolean
  available: boolean
  tools: boolean
  thinking?: readonly string[]
  input?: readonly string[]
  contextWindow?: number
}
export interface InstalledCapability {
  id: string
  name: string
  thinking: readonly ThinkingLevel[]
  input: readonly ("text" | "image")[]
  responses: boolean
  contextWindow: number
}

export function reconcileCatalog(
  account: readonly CatalogCandidate[],
  installed: readonly InstalledCapability[],
  now: string
): ModelCatalog {
  const models: ModelCapability[] = account
    .filter((candidate) => candidate.visible)
    .map((candidate) => {
      const native = installed.find((model) => model.id === candidate.id)
      const contextWindow = Math.max(
        0,
        Math.min(
          native?.contextWindow ?? 0,
          candidate.contextWindow ?? native?.contextWindow ?? 0
        )
      )
      return {
        id: candidate.id,
        name: candidate.name,
        thinking:
          native?.thinking.filter(
            (effort) =>
              !candidate.thinking || candidate.thinking.includes(effort)
          ) ?? [],
        input:
          native?.input.filter(
            (mode) => !candidate.input || candidate.input.includes(mode)
          ) ?? [],
        tools: !!native?.responses && candidate.tools,
        contextWindow,
        unavailable:
          !native?.responses || !candidate.available
            ? "Not supported by the installed Pi Responses adapter."
            : contextWindow <= 0
              ? "No verified context budget."
              : null,
      }
    })
  for (const id of ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"]) {
    if (!models.some((model) => model.id === id))
      models.push({
        id,
        name: installed.find((model) => model.id === id)?.name ?? id,
        thinking: [],
        input: [],
        tools: false,
        contextWindow: 0,
        unavailable: "Not available to the connected ChatGPT account.",
      })
  }
  return { models, checkedAt: now, error: null, usage: "ChatGPT plan usage" }
}
