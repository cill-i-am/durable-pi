import { preserveFatal } from "../../shared/effect"
import { runObserved } from "../../observability/worker"
import { Effect } from "effect"
import { MAX_FILE_BYTES } from "../files"
import { workspaceRequestBytes } from "./http"
import { DocumentUnreadable } from "../documents"
import { extractPdf } from "./pdf"

export default {
  async fetch(request: Request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/pdf")
      return new Response("Not found", { status: 404 })
    return runObserved(
      Effect.gen(function* () {
        const bytes = yield* workspaceRequestBytes(
          request,
          MAX_FILE_BYTES
        ).pipe(
          preserveFatal,
          Effect.mapError(() => new DocumentUnreadable({ reason: "invalid" }))
        )
        return yield* extractPdf(bytes)
      }).pipe(
        Effect.map((result) => Response.json(result)),
        preserveFatal,
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
