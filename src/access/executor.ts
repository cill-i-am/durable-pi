import type { ConnectionInfo, RemoteTool } from "./connections"
import type { ToolPolicy } from "./contracts"

export const executorUrl =
  "https://mcp.executor.sh/mcp?elicitation_mode=browser"
const methods = new Set([
  "skills",
  "search",
  "describe",
  "call",
  "execute",
  "resume",
])

export function isExecutorConnection(url: string) {
  return url === executorUrl
}

/** Only the hosted browser-approval endpoint and its six stable entry points
 * inherit workspace access. A server name or a read-only annotation grants none. */
export function executorDefaultTools(connections: readonly ConnectionInfo[]) {
  const connection = connections
    .filter(
      (value) =>
        value.active &&
        value.status === "ready" &&
        isExecutorConnection(value.url)
    )
    .sort((a, b) => a.id.localeCompare(b.id))[0]
  return connection?.tools.filter((tool) => methods.has(tool.remoteName)) ?? []
}

export function connectedTools(
  selected: readonly RemoteTool[],
  defaults: readonly RemoteTool[]
) {
  return [
    ...new Map(
      [...defaults, ...selected].map((tool) => [tool.name, tool])
    ).values(),
  ]
}

export function connectedToolPolicies(
  selected: readonly RemoteTool[],
  defaults: readonly RemoteTool[]
): Omit<ToolPolicy, "revision">[] {
  return connectedTools(selected, defaults).map((tool) => ({
    name: tool.name,
    title: `${tool.connectionName} / ${tool.remoteName}`,
    description: tool.description,
    mode: defaults.some((value) => value.name === tool.name) ? "allow" : "ask",
  }))
}
