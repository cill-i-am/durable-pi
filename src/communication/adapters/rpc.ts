import { Effect, Layer } from "effect"
import { HttpEffect } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { bindEffectRpc, fromCloudflareFetcher } from "alchemy/Cloudflare/Bridge"
import {
  CommunicationError,
  MailboxRpc,
  failure,
  type Envelope,
  type Receipt,
} from "../contracts"
import { Mailbox, MailboxTransport } from "../mailbox"
import { receive } from "../delivery"
import { agentObjectName } from "../../agents/domain"

type FetchNamespace = { getByName: (name: string) => Fetcher }

/** Alchemy's supported Effect RPC bridge, carried exclusively by private DO fetch. */
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
    ) => Effect.Effect<T, unknown>
  ) =>
    Effect.gen(function* () {
      const rpc = yield* client.getByName(agentObjectName(e.owner, target))
      return yield* body(rpc)
    }).pipe(
      Effect.catch((error) =>
        Effect.fail(
          error instanceof CommunicationError
            ? error
            : failure("transport", "Private mailbox request failed.")
        )
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
        // The envelope is a claim. Proof is the exact committed outbox at the
        // registered sender, reached through the recipient's own private binding.
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

/** Per-request scope owns the RPC server fibers, serialization and cancellation. */
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
      // Persist a Lifecycle wake before acceptance; the acknowledgment follows
      // the synchronous acceptance transaction. Acceptance never calls Pi.
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
        const body = yield* boundedFrame(request)
        return yield* Effect.tryPromise({
          try: () => handler(new Request(request, { body })),
          catch: () => failure("transport", "Mailbox unavailable."),
        })
      }).pipe(
        Effect.timeout("15 seconds"),
        Effect.catch(() =>
          Effect.succeed(
            new Response("Invalid or unavailable mailbox request", {
              status: 400,
            })
          )
        )
      )
    )
}

/** Private does not mean unbounded: 96 KiB request limit and an owned reader. */
export const boundedFrame = (request: Request) =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => request.body?.getReader(),
      catch: () => failure("invalid", "Invalid request body."),
    }),
    (reader) =>
      Effect.gen(function* () {
        if (!reader)
          return yield* Effect.fail(
            failure("invalid", "Missing request frame.")
          )
        let size = 0
        const chunks: Uint8Array[] = []
        let done = false
        while (!done) {
          const chunk = yield* Effect.tryPromise({
            try: () => reader.read(),
            catch: () => failure("invalid", "Unreadable frame."),
          })
          if (chunk.done) {
            done = true
            continue
          }
          size += chunk.value.length
          if (size > 96 * 1024)
            return yield* Effect.fail(
              failure("invalid", "Request frame is too large.")
            )
          chunks.push(chunk.value)
        }
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.length
        }
        return bytes
      }),
    (reader) =>
      Effect.promise(async () => {
        try {
          await reader?.cancel()
        } finally {
          reader?.releaseLock()
        }
      }).pipe(Effect.ignore)
  )
