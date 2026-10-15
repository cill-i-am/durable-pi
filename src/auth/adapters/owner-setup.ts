import { isAPIError } from "better-auth/api"
import { Cause, Effect, Exit, Schema } from "effect"
import { matchesSecret, sameOrigin } from "../server"
import { jsonRequest } from "../../shared/http"
import { nativeOperation } from "../../shared/interop"
import { preserveFatal } from "../../shared/effect"
import { WorkerTelemetry } from "../../observability/worker"
import { reportService } from "../../observability/events"

const Setup = Schema.Struct({
  password: Schema.String.check(
    Schema.isMinLength(12),
    Schema.isMaxLength(128)
  ),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
})
export class OwnerSetupRejected extends Schema.TaggedError<OwnerSetupRejected>()(
  "OwnerSetupRejected",
  {
    reason: Schema.Literals([
      "unauthorized",
      "registered",
      "invalid",
      "unavailable",
    ]),
  }
) {}

export interface OwnerSetupBindings {
  readonly appUrl: string
  readonly ownerEmail: string
  readonly secret: string
  readonly registered: () => Promise<boolean>
  readonly signUp: (
    body: typeof Setup.Type & { email: string }
  ) => Promise<void>
  readonly own: (work: Promise<unknown>) => void
}
const rejected = (reason: OwnerSetupRejected["reason"]) =>
  new OwnerSetupRejected({ reason })
const native = <T>(start: () => Promise<T>) =>
  nativeOperation(start, (cause, channel) => {
    const expected = Schema.decodeUnknownOption(OwnerSetupRejected)(cause)
    if (expected._tag === "Some") return expected.value
    if (channel === "failure" || Schema.isSchemaError(cause)) throw cause
    return rejected(
      isAPIError(cause) && cause.statusCode >= 400 && cause.statusCode < 500
        ? "invalid"
        : "unavailable"
    )
  })
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
}
const response = (error: OwnerSetupRejected) => {
  switch (error.reason) {
    case "unauthorized":
      return Response.json(
        { error: "Setup is not authorized." },
        { status: 403, headers }
      )
    case "registered":
      return Response.json(
        { error: "Owner already registered." },
        { status: 409, headers }
      )
    case "invalid":
      return Response.json(
        {
          error:
            "Could not create the owner. Check your password and try again.",
        },
        { status: 400, headers }
      )
    case "unavailable":
      return Response.json(
        {
          error:
            "Owner setup is temporarily unavailable. Reload and try again.",
        },
        { status: 503, headers }
      )
  }
}

/** One native HTTP interpretation. Better Auth owns the actual user write;
 * cancellation joins its acknowledgement and never claims to undo that write. */
export async function ownerSetup(
  request: Request,
  bindings: OwnerSetupBindings
): Promise<Response> {
  const program = Effect.yieldNow.pipe(
    Effect.andThen(
      Effect.gen(function* () {
        if (!sameOrigin(request, bindings.appUrl))
          return yield* rejected("unauthorized")
        const authorized = yield* nativeOperation(
          () =>
            matchesSecret(
              request.headers.get("x-setup-token") ?? "",
              bindings.secret
            ),
          (cause) => {
            throw cause
          }
        )
        if (!authorized) return yield* rejected("unauthorized")
        if (yield* native(bindings.registered))
          return yield* rejected("registered")
        const body = yield* jsonRequest(request, Setup, 16_384, () =>
          rejected("invalid")
        )
        yield* native(() =>
          bindings.signUp({ ...body, email: bindings.ownerEmail })
        )
        return Response.json({ ok: true }, { headers })
      })
    ),
    preserveFatal,
    Effect.catchTag("OwnerSetupRejected", (error) =>
      Effect.succeed(response(error))
    ),
    Effect.onExit((exit) =>
      Exit.isFailure(exit)
        ? Effect.sync(() => reportService(exit.cause, "website"))
        : Effect.void
    ),
    Effect.withSpan("Website.ownerSetup"),
    Effect.provide(WorkerTelemetry)
  )
  const stopped = new AbortController()
  const pending = Effect.runPromiseExit(program, {
    signal: AbortSignal.any([request.signal, stopped.signal]),
  })
  let registration: Cause.Cause<never> | undefined
  try {
    bindings.own(pending)
  } catch (cause) {
    registration = Cause.die(cause)
    stopped.abort()
  }
  const exit = await pending
  if (registration)
    throw Exit.isFailure(exit)
      ? Cause.combine(registration, exit.cause)
      : registration
  if (Exit.isFailure(exit)) throw exit.cause
  return exit.value
}
