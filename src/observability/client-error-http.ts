import { Effect } from "effect"

import { jsonRequest } from "../shared/http"
import { ClientErrorReport } from "./client-errors"
import { OperationalLogger } from "./logger"

export async function clientErrorRequest(
  request: Request,
  bindings: {
    appUrl: string
    authorize: () => Promise<boolean>
    record?: (report: ClientErrorReport) => void
  }
) {
  const response = (status: number) =>
    new Response(null, {
      status,
      headers: { "cache-control": "private, no-store" },
    })
  if (request.method !== "POST") return response(405)
  if (request.headers.get("origin") !== new URL(bindings.appUrl).origin)
    return response(403)
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  )
    return response(415)
  try {
    if (!(await bindings.authorize())) return response(401)
    const parsed = await Effect.runPromise(
      jsonRequest(request, ClientErrorReport, 16_384, () => "invalid").pipe(
        Effect.result
      )
    )
    if (parsed._tag === "Failure") return response(400)
    if (bindings.record) bindings.record(parsed.success)
    else
      Effect.runSync(
        Effect.logError("Browser.workspaceFailed").pipe(
          Effect.annotateLogs({ event: "browser.error", ...parsed.success }),
          Effect.provide(OperationalLogger)
        )
      )
    return response(204)
  } catch {
    return response(503)
  }
}
