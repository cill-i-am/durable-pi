import { Schema } from "effect"

import { ClientErrorReport, clientFailure, errorPage } from "./client-errors"

// Browser-only state: SSR never records request data in this module.
const reports = new WeakMap<object, Promise<string | undefined>>()
let recent: number[] = []
export function reportClientError(
  error: unknown,
  info?: { componentStack?: string | null },
  surface: ClientErrorReport["surface"] = "workspace"
): Promise<string | undefined> {
  if (typeof window === "undefined") return Promise.resolve(undefined)
  try {
    if (error !== null && typeof error === "object") {
      const prior = reports.get(error)
      if (prior) return prior
    }
    recent = recent.filter((at) => at > Date.now() - 60_000)
    if (recent.length >= 5) return Promise.resolve(undefined)
    recent.push(Date.now())
    const build: unknown = import.meta.env.VITE_BUILD_ID
    const report = Schema.decodeUnknownSync(ClientErrorReport)({
      id: crypto.randomUUID(),
      build: build ?? "development",
      surface,
      page: errorPage(window.location.pathname),
      online: navigator.onLine,
      ...clientFailure(
        error,
        window.location.origin,
        info?.componentStack ?? ""
      ),
    })
    const task = fetch("/api/diagnostics/client-error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
      keepalive: true,
      signal: AbortSignal.timeout(5000),
    })
      .then((response) => (response.status === 204 ? report.id : undefined))
      .catch(() => undefined)
    if (error !== null && typeof error === "object") reports.set(error, task)
    return task
  } catch {
    // Logging must never break the recovery screen or create a rejection loop.
    return Promise.resolve(undefined)
  }
}
export function listenForClientErrors() {
  const onError = (event: ErrorEvent) => {
    void reportClientError(
      event.error ?? {
        message: event.message,
        stack: `at ${event.filename}:${event.lineno}:${event.colno}`,
      },
      undefined,
      "window-error"
    )
  }
  const onRejection = (event: PromiseRejectionEvent) => {
    void reportClientError(event.reason, undefined, "unhandled-rejection")
  }
  window.addEventListener("error", onError)
  window.addEventListener("unhandledrejection", onRejection)
  return () => {
    window.removeEventListener("error", onError)
    window.removeEventListener("unhandledrejection", onRejection)
  }
}
