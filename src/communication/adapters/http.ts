import { Effect, Schema } from "effect"

import { preserveFatal } from "../../shared/effect"
import { Communication } from "../communication"
import { MailboxControl, MessageId, failure } from "../contracts"
import { boundedFrame } from "./input"

export function communicationRequest(request: Request, path: string) {
  return Effect.gen(function* () {
    const app = yield* Communication
    if (path === "communication" && request.method === "GET")
      return Response.json(yield* app.read())
    if (path === "communication/control" && request.method === "POST") {
      const text = new TextDecoder().decode(yield* boundedFrame(request, 2048))
      const input = yield* Effect.try({
        try: () => {
          if (text.length > 2048) throw new Error()
          return Schema.decodeUnknownSync(
            Schema.fromJsonString(MailboxControl)
          )(text)
        },
        catch: () => failure("invalid", "Invalid task control."),
      })
      if (input.action === "cancel") yield* app.cancel(input.id)
      else yield* app.retry(input.id)
      return Response.json({ ok: true })
    }
    if (path.startsWith("communication/") && request.method === "GET") {
      const id = yield* Schema.decodeUnknownEffect(MessageId)(
        decodeURIComponent(path.slice("communication/".length))
      ).pipe(
        Effect.mapError(() => failure("invalid", "Invalid task identity."))
      )
      return Response.json(yield* app.get(id))
    }
    return new Response("Not found", { status: 404 })
  }).pipe(
    preserveFatal,
    Effect.catchTag("CommunicationError", (error) =>
      Effect.succeed(
        Response.json(
          { error: error.message, code: error.code },
          {
            status:
              error.code === "not_found"
                ? 404
                : error.code === "forbidden"
                  ? 403
                  : error.code === "conflict" || error.code === "stale"
                    ? 409
                    : error.code === "storage" || error.code === "transport"
                      ? 503
                      : 400,
          }
        )
      )
    )
  )
}
