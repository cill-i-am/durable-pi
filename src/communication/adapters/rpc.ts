import { preserveFatal, observeCleanup } from "../../shared/effect"
import { Effect, Layer } from "effect"
import { HttpEffect } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { bindEffectRpc, fromCloudflareFetcher } from "alchemy/Cloudflare/Bridge"
import {
  type CommunicationError,
  failure,
  type Envelope,
  type Receipt,
} from "../contracts"
import { MailboxRpc } from "./protocol"
import { Mailbox, MailboxTransport } from "../mailbox"
import { receive } from "../delivery"
import { agentObjectName } from "../../agents/domain"
import type { RpcClientError } from "effect/rpc/RpcClientError"
import { communicationNative } from "./interop"
import { boundedFrame } from "./input"

export { boundedFrame } from "./input"

type FetchNamespace = { getByName: (name: string) => Fetcher }

export const isMailboxRequest = (request: Request) =>
  request.method === "POST" && new URL(request.url).pathname === "/"

export function privateMailboxClient(namespace: FetchNamespace) {
  return bindEffectRpc(
    {
      getByName: (name) => fromCloudflareFetcher(namespace.getByName(name)),
    },
    MailboxRpc
  )
}

export function mailboxTransport(
  namespace: FetchNamespace,
  authorize: (envelope: Envelope) => Effect.Effect<void, CommunicationError>
) {
  const client = privateMailboxClient(namespace)
  const call = <T>(
    e: Envelope,
    target: Envelope["from"],
    body: (
      rpc: Effect.Success<ReturnType<typeof client.getByName>>
    ) => Effect.Effect<T, CommunicationError | RpcClientError>
  ) =>
    Effect.gen(function* () {
      const rpc = yield* client.getByName(agentObjectName(e.owner, target))
      return yield* body(rpc)
    }).pipe(
      preserveFatal,
      Effect.catchTag("RpcClientError", (error) =>
        error.reason._tag === "RpcClientDefect"
          ? Effect.die(error)
          : Effect.fail(failure("transport", "Private mailbox request failed."))
      ),
      Effect.scoped
    )
  return Layer.succeed(MailboxTransport, {
    deliver: (e): Effect.Effect<Receipt, CommunicationError> =>
      call(e, e.to, (rpc) => rpc.deliver({ envelope: e })),
    permitted: (e) => call(e, e.from, (rpc) => rpc.permit({ envelope: e })),
    authenticate: (e) =>
      Effect.gen(function* () {
        yield* authorize(e)
        const proven = yield* call(e, e.from, (rpc) =>
          rpc.prove({ envelope: e })
        )
        if (!proven)
          return yield* Effect.fail(
            failure("forbidden", "Sender has no matching committed message.")
          )
      }),
  })
}

export function mailboxHandler(
  mailbox: Mailbox["Service"],
  transport: Layer.Layer<MailboxTransport>,
  arm: () => Effect.Effect<void, CommunicationError>,
  permit: (
    envelope: Envelope
  ) => Effect.Effect<boolean, CommunicationError> = () => Effect.succeed(false)
) {
  const services = Layer.merge(Layer.succeed(Mailbox, mailbox), transport)
  const handlers = MailboxRpc.toLayer({
    deliver: ({ envelope }) => {
      return receive(envelope, arm())
    },
    prove: ({ envelope }) => mailbox.prove(envelope),
    permit: ({ envelope }) => permit(envelope),
  }).pipe(Layer.provide(services))
  const handler = HttpEffect.toWebHandler(
    Effect.gen(function* () {
      const handle = yield* RpcServer.toHttpEffect(MailboxRpc, {
        disableTracing: true,
      }).pipe(
        Effect.provide(Layer.merge(handlers, RpcSerialization.layerNdjson))
      )
      return yield* handle
    })
  )
  return (request: Request) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.yieldNow
        const body = yield* boundedFrame(request)
        return yield* communicationNative(
          () => handler(new Request(request, { body: Uint8Array.from(body) })),
          "transport"
        )
      }).pipe(
        (timed) =>
          observeCleanup(timed, (observed) =>
            observed.pipe(Effect.timeout("15 seconds"))
          ),
        preserveFatal,
        Effect.catch(() =>
          Effect.succeed(
            new Response("Invalid or unavailable mailbox request", {
              status: 400,
            })
          )
        )
      ),
      { signal: request.signal }
    )
}
