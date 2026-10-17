import { Effect } from "effect"

import { preserveFatal } from "../../shared/effect"
import { jsonRequest } from "../../shared/http"
import {
  ConfigureEmail,
  EmailRejected,
  RetryEmail,
  IncomingEmail,
  type EmailView,
  type EmailFailure,
} from "../contracts"

export function emailRequest(
  request: Request,
  path: string,
  host: {
    view: () => Effect.Effect<EmailView, EmailFailure>
    receive: (input: IncomingEmail) => Effect.Effect<boolean, EmailFailure>
    configure: (input: ConfigureEmail) => Effect.Effect<unknown, EmailFailure>
    retry: (
      input: typeof RetryEmail.Type
    ) => Effect.Effect<unknown, EmailFailure>
  }
) {
  return Effect.gen(function* () {
    if (request.method === "POST" && path === "email/incoming") {
      const input = yield* jsonRequest(
        request,
        IncomingEmail,
        160_000,
        () => new EmailRejected({ message: "Invalid incoming email." })
      )
      return Response.json(
        { accepted: yield* host.receive(input) },
        { status: 202 }
      )
    }
    if (request.method === "POST" && path === "email/configure") {
      const input = yield* jsonRequest(
        request,
        ConfigureEmail,
        2048,
        () => new EmailRejected({ message: "Invalid email settings." })
      )
      yield* host.configure(input)
    } else if (request.method === "POST" && path === "email/retry") {
      const input = yield* jsonRequest(
        request,
        RetryEmail,
        2048,
        () => new EmailRejected({ message: "Invalid email retry." })
      )
      yield* host.retry(input)
    } else if (request.method !== "GET" || path !== "email")
      return new Response("Not found", { status: 404 })
    return Response.json(yield* host.view(), {
      headers: { "Cache-Control": "no-store" },
    })
  }).pipe(
    preserveFatal,
    Effect.catchTags({
      EmailRejected: (error) =>
        Effect.succeed(
          Response.json({ error: error.message }, { status: 409 })
        ),
      EmailStorageError: () =>
        Effect.succeed(
          Response.json(
            {
              error:
                "Email storage is temporarily unavailable. Retry the same request.",
            },
            { status: 503 }
          )
        ),
      EmailUnavailable: () =>
        Effect.succeed(
          Response.json(
            { error: "Email is not configured for this environment." },
            { status: 503 }
          )
        ),
    })
  )
}
