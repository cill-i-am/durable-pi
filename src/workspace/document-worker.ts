import { runObserved } from "../observability/worker"
import { Effect } from "effect"
import { MAX_FILE_BYTES } from "./files"
import { boundedBytes } from "./http"
import { extractPdf } from "./adapters/pdf"

/** Binding-only parser with an independent platform CPU/memory limit. */
export default {
  async fetch(request: Request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/pdf")
      return new Response("Not found", { status: 404 })
    let bytes: Uint8Array
    try {
      bytes = await boundedBytes(request, MAX_FILE_BYTES)
    } catch {
      return Response.json({ reason: "invalid" }, { status: 422 })
    }
    return runObserved(
      extractPdf(bytes).pipe(
        Effect.map((result) => Response.json(result)),
        Effect.catchTag("DocumentUnreadable", (cause) =>
          Effect.succeed(
            Response.json({ reason: cause.reason }, { status: 422 })
          )
        )
      ),
      { signal: request.signal }
    )
  },
}
