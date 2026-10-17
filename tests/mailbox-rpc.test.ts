import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { HttpEffect } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { expect, it, vi } from "vitest"

import { AgentId } from "../src/agents/domain"
import { MailboxRpc } from "../src/communication/adapters/protocol"
import { mailboxTransport } from "../src/communication/adapters/rpc"
import { failure, type Envelope } from "../src/communication/contracts"
import { MailboxTransport } from "../src/communication/mailbox"

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
  RpcTarget: class {},
  env: {},
  tracing: undefined,
}))

const envelope: Envelope = {
  version: 1,
  id: "request",
  taskId: "request",
  owner: "owner",
  from: Schema.decodeUnknownSync(AgentId)("home"),
  to: Schema.decodeUnknownSync(AgentId)("00000000-0000-4000-8000-000000000001"),
  correlationId: "turn",
  causationId: "tool",
  createdAt: 0,
  deadline: 1000,
  depth: 1,
  payload: { kind: "question", objective: "Compare", context: "Text only" },
}
function transport(fetch: typeof globalThis.fetch) {
  const binding: Fetcher = {
    fetch,
    connect: () => {
      throw new Error("Unexpected socket")
    },
  }
  return Effect.runSync(
    MailboxTransport.pipe(
      Effect.provide(
        mailboxTransport({ getByName: () => binding }, () => Effect.void)
      )
    )
  )
}
function handler(cause: Cause.Cause<ReturnType<typeof failure>>) {
  const handlers = MailboxRpc.toLayer({
    deliver: () => Effect.failCause(cause),
    prove: () => Effect.succeed(true),
    permit: () => Effect.succeed(true),
  })
  const serve = HttpEffect.toWebHandler(
    Effect.flatMap(
      RpcServer.toHttpEffect(MailboxRpc, { disableTracing: true }).pipe(
        Effect.provide(Layer.merge(handlers, RpcSerialization.layerNdjson))
      ),
      (handle) => handle
    )
  )
  return transport((input, init) => serve(new Request(input, init)))
}

it("retains the declared mailbox error through the real Effect RPC codecs", async () => {
  const exit = await Effect.runPromiseExit(
    handler(
      Cause.fail(failure("forbidden", "Owner denied this task."))
    ).deliver(envelope)
  )
  expect(Exit.isFailure(exit) && exit.cause.reasons).toMatchObject([
    { _tag: "Fail", error: { _tag: "CommunicationError", code: "forbidden" } },
  ])
})
it("does not recover a remote tagged defect as a normal mailbox rejection", async () => {
  const exit = await Effect.runPromiseExit(
    handler(Cause.die(failure("forbidden", "Private defect"))).deliver(envelope)
  )
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
})
it("does not turn malformed private RPC data into ordinary unavailability", async () => {
  const app = transport(
    async () =>
      new Response('{"_tag":"unknown-frame"}\n', {
        headers: { "content-type": "application/ndjson" },
      })
  )
  const exit = await Effect.runPromiseExit(app.deliver(envelope))
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
})
