import {
  AccessConflict,
  AccessDenied,
  type AccessMode,
  type ToolPolicy,
} from "./contracts"

export function requirePolicy(policy: ToolPolicy | undefined): ToolPolicy {
  if (!policy) throw new AccessDenied({ message: "This tool is unavailable." })
  return policy
}

export function revisePolicy(
  current: ToolPolicy,
  expected: number,
  mode: AccessMode
): ToolPolicy {
  if (
    current.mode === mode &&
    (current.revision === expected || current.revision === expected + 1)
  )
    return current
  if (current.revision !== expected)
    throw new AccessConflict({
      message: "Tool access changed. Reload before updating it.",
    })
  return { ...current, mode, revision: current.revision + 1 }
}

export function validateResult(result: string) {
  if (result.length > 250_000)
    throw new AccessDenied({
      message: "Tool output exceeded its stored result limit.",
    })
}
