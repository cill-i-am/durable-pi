import { Cause, Effect, Exit, Schema } from "effect"
import { nativeOperation, releaseUnreadResponse } from "../../shared/interop"
import { releaseForwardedResponse } from "../../shared/adapters/response"
import { preserveFatal } from "../../shared/effect"
import {
  type OwnerSessionUnavailable,
  sessionUnavailableResponse,
} from "../owner-session"
import { sessionSocketResponse, type SessionSocket } from "./session-socket"
import { WorkerTelemetry } from "../../observability/worker"
import { reportService } from "../../observability/events"
import { encodeEventStream } from "./event-stream-encoding"

export interface AgentProxyBindings {
  readonly appUrl: string
  readonly owner: Effect.Effect<
    { readonly id: string } | null,
    OwnerSessionUnavailable
  >
  readonly forward: (request: Request) => Promise<Response>
  readonly own: (work: Promise<unknown>) => void
  readonly connect?: typeof sessionSocketResponse
}
class AgentProxyUnavailable extends Schema.TaggedError<AgentProxyUnavailable>()(
  "AgentProxyUnavailable",
  { cause: Schema.Unknown }
) {}
const native = <T>(start: (signal: AbortSignal) => Promise<T>) =>
  nativeOperation(start, (cause, channel) => {
    if (channel === "failure" || Schema.isSchemaError(cause)) throw cause
    return new AgentProxyUnavailable({ cause })
  })
const cleanup = (close: () => void) =>
  nativeOperation(
    () => Promise.resolve().then(close),
    (cause) => {
      throw cause
    }
  )
const privateResponse = (response: Response) => {
  const out = new Response(response.body, response)
  out.headers.set("Cache-Control", "private, no-store")
  out.headers.set("X-Content-Type-Options", "nosniff")
  return out
}

/** Native website entrypoint. The request owns responses and the socket bridge
 * until handoff; subsequent read-only session checks are owned by the Worker. */
export async function agentProxy(
  request: Request,
  bindings: AgentProxyBindings
): Promise<Response> {
  let acquired: Response | undefined
  let outgoing: Response | undefined
  let session: SessionSocket | undefined
  const release = () =>
    Effect.gen(function* () {
      const response = acquired,
        encoded = outgoing,
        active = session
      acquired = undefined
      outgoing = undefined
      session = undefined
      const failures: Cause.Reason<never>[] = []
      for (const work of [
        active ? cleanup(active.close) : Effect.void,
        encoded ? releaseUnreadResponse(encoded) : Effect.void,
        response
          ? active
            ? releaseUnreadResponse(response)
            : releaseForwardedResponse(response)
          : Effect.void,
      ]) {
        yield* work.pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              failures.push(...cause.reasons)
            })
          )
        )
      }
      if (failures.length)
        return yield* Effect.failCause(Cause.fromReasons(failures))
    })
  const revalidate = async (id: string): Promise<boolean> => {
    const pending = Effect.runPromiseExit(
      bindings.owner.pipe(Effect.provide(WorkerTelemetry))
    )
    let registration: Cause.Cause<never> | undefined
    try {
      bindings.own(pending)
    } catch (cause) {
      registration = Cause.die(cause)
    }
    const exit = await pending
    if (registration !== undefined)
      throw Cause.combine(
        registration,
        Exit.isFailure(exit) ? exit.cause : Cause.empty
      )
    if (Exit.isFailure(exit)) throw exit.cause
    return exit.value?.id === id
  }
  const program = Effect.gen(function* () {
    yield* Effect.yieldNow
    yield* Effect.addFinalizer((exit) =>
      Exit.isFailure(exit) ? release() : Effect.void
    )
    const appOrigin = new URL(bindings.appUrl).origin
    if (
      (request.method !== "GET" ||
        request.headers.get("upgrade") === "websocket") &&
      request.headers.get("origin") !== appOrigin
    )
      return privateResponse(new Response("Forbidden", { status: 403 }))
    const owner = yield* bindings.owner
    if (!owner)
      return privateResponse(new Response("Unauthorized", { status: 401 }))
    const headers = new Headers({
      "content-type": request.headers.get("content-type") ?? "application/json",
      "x-owner-id": owner.id,
      "x-app-origin": appOrigin,
    })
    if (request.headers.get("upgrade") === "websocket")
      headers.set("upgrade", "websocket")
    const url = new URL(request.url)
    const response = yield* native((signal) =>
      bindings
        .forward(
          new Request(
            new Request(
              `https://agent.internal${url.pathname}${url.search}`,
              request
            ),
            {
              redirect: "manual",
              headers,
              signal,
            }
          )
        )
        .then((value) => {
          acquired = value
          return value
        })
    )
    const upstream = response.webSocket
    if (response.status === 101 && upstream) {
      // Forwarding may have waited on another object. Check the same owner again
      // before accepting a long-lived connection; future checks remain fresh.
      const latest = yield* bindings.owner
      if (latest?.id !== owner.id) {
        yield* release()
        return privateResponse(new Response("Unauthorized", { status: 401 }))
      }
      return yield* nativeOperation(
        () =>
          Promise.resolve().then(() => {
            session = (bindings.connect ?? sessionSocketResponse)(
              upstream,
              () => revalidate(owner.id),
              (cause) => reportService(cause, "website")
            )
            return session.response
          }),
        (cause) => {
          throw cause
        }
      )
    }
    // Retain both until handoff: encoding owns and locks the original body.
    // A late host registration failure must cancel the returned body too.
    outgoing = yield* encodeEventStream(request, privateResponse(response))
    return outgoing
  }).pipe(
    Effect.scoped,
    Effect.onExit((exit) =>
      Exit.isFailure(exit)
        ? Effect.sync(() => reportService(exit.cause, "website"))
        : Effect.void
    ),
    preserveFatal,
    Effect.catchTags({
      OwnerSessionUnavailable: (error) =>
        sessionUnavailableResponse(error).pipe(Effect.map(privateResponse)),
      AgentProxyUnavailable: () =>
        Effect.succeed(
          privateResponse(
            Response.json(
              { error: "This bot is temporarily unavailable. Please retry." },
              { status: 503 }
            )
          )
        ),
    }),
    Effect.withSpan("Website.agentRequest", {
      attributes: { "http.request.method": request.method },
    }),
    Effect.provide(WorkerTelemetry)
  )
  const pending = Effect.runPromiseExit(program, { signal: request.signal })
  let registration: Cause.Cause<never> | undefined
  try {
    bindings.own(pending)
  } catch (cause) {
    registration = Cause.die(cause)
  }
  const exit = await pending
  if (registration) {
    const released = await Effect.runPromiseExit(release())
    if (Exit.isFailure(released))
      registration = Cause.combine(registration, released.cause)
    if (Exit.isFailure(exit))
      registration = Cause.combine(registration, exit.cause)
    reportService(registration, "website")
    throw registration
  }
  if (Exit.isFailure(exit)) throw exit.cause
  return exit.value
}
