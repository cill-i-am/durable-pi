export function errorMessage(value: unknown) {
  return typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
    ? value.error
    : "The request failed."
}
export async function api<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal
): Promise<T> {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    signal,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) {
    if (response.status === 401)
      throw new Error("Your session has expired. Sign in again.")
    const error = await response
      .json()
      .catch(() => ({ error: "Connection interrupted. Please retry." }))
    throw new Error(errorMessage(error))
  }
  return response.json()
}

export function agentUrl(agentId: string, path: string) {
  const url = new URL(`/api/agent/${path}`, "https://app.internal")
  url.searchParams.set("agent", agentId)
  return url.pathname + url.search
}
export function agentApi(agentId: string) {
  return <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    api<T>(agentUrl(agentId, path), body, signal)
}
