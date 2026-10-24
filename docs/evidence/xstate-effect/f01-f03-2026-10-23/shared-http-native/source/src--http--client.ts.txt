import { Cause } from "effect"

import { fatalCause } from "@/shared/effect"
import { nativeFailure } from "@/shared/interop"

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message)
  }
}
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
  let outcome: { value: T } | { cause: unknown }
  try {
    if (!response.ok) {
      if (response.status === 401)
        throw new ApiError(401, "Your session has expired. Sign in again.")
      const error = await response.json().catch((cause: unknown) => {
        // Native structured failures retain all reasons and annotations. Only
        // an ordinary unreadable HTTP error payload uses the existing fallback.
        if (Cause.isCause(cause)) throw cause
        return { error: "Connection interrupted. Please retry." }
      })
      throw new ApiError(
        response.status,
        errorMessage(error),
        typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
          ? error.code
          : undefined
      )
    }
    outcome = { value: await response.json() }
  } catch (cause) {
    outcome = { cause }
  }
  const responseBody = response.body
  if (responseBody && !response.bodyUsed && !responseBody.locked) {
    try {
      await responseBody.cancel()
    } catch (cause) {
      const cleanup = fatalCause(nativeFailure(cause, (error) => error))
      throw "cause" in outcome
        ? Cause.combine(
            nativeFailure(outcome.cause, (error) => error),
            cleanup
          )
        : cleanup
    }
  }
  if ("cause" in outcome) throw outcome.cause
  return outcome.value
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
