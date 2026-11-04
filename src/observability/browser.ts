import { createEffectActor, waitFor } from "@xstate/effect"
import { Effect, Schema } from "effect"

import { nativeResponse } from "../shared/interop"
import {
  initialReportAdmission,
  admitReport,
  browserReportMachine,
} from "./browser-report.machine"
import { ClientErrorReport, clientFailure, errorPage } from "./client-errors"

// Browser-only state: SSR never records request data in this module.
const reports = new WeakMap<object, Promise<string | undefined>>()
let admission = initialReportAdmission()
export function reportClientError(
  error: unknown,
  info?: { componentStack?: string | null },
  surface: ClientErrorReport["surface"] = "workspace"
): Promise<string | undefined> {
  if (typeof window === "undefined") return Promise.resolve(undefined)
  try {
    const key = error !== null && typeof error === "object" ? error : undefined
    const prior = key ? reports.get(key) : undefined
    admission = admitReport(admission, Date.now(), prior !== undefined)
    if (admission.context.decision === "reuse") return prior!
    if (admission.context.decision === "drop") return Promise.resolve(undefined)
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
    const task = Effect.runPromise(
      Effect.gen(function* () {
        const actor = yield* createEffectActor(
          browserReportMachine(
            nativeResponse(
              (signal) =>
                fetch("/api/diagnostics/client-error", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(report),
                  keepalive: true,
                  signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
                }),
              (cause) => cause
            ).pipe(
              Effect.map((response) =>
                response.status === 204 ? report.id : undefined
              ),
              Effect.scoped
            )
          )
        )
        const settled = yield* waitFor(
          actor,
          (state) => state.status === "done"
        )
        return settled.output
      }).pipe(Effect.scoped)
    ).catch(() => undefined)
    if (key) reports.set(key, task)
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
