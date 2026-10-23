import { Cause, Context, Effect, Exit } from "effect"
import { expect, expectTypeOf, it } from "vitest"

import {
  connectionDecode,
  connectionJson,
  connectionRequest,
  connectionResponse,
} from "../src/access/adapters/connection-http"
import type { RemoteConnectionOperations } from "../src/access/connection-service"
import {
  ConnectionError,
  ConnectionStorageError,
  ConnectionTransportError,
  SelectRemoteTools,
} from "../src/access/connections"

const incomplete =
  "The connection request could not be completed. Reload and try again."
const transport =
  "Could not connect. This server must support public HTTPS MCP and, if required, OAuth registration. Reload to check its status."

it("declares the finite error contract and retains caller requirements", async () => {
  type Errors = Effect.Error<Parameters<typeof connectionResponse>[0]>
  expectTypeOf<Errors["_tag"]>().toEqualTypeOf<
    | "ConnectionError"
    | "ConnectionStorageError"
    | "ConnectionTransportError"
    | "ConnectionRequestInvalid"
  >()
  class Caller extends Context.Service<Caller, { marker: string }>()(
    "Caller"
  ) {}
  const response = connectionResponse(
    Effect.gen(function* () {
      const caller = yield* Caller
      return { marker: caller.marker }
    })
  )
  expectTypeOf(response).toEqualTypeOf<Effect.Effect<Response, never, Caller>>()
  const result = await Effect.runPromise(
    response.pipe(Effect.provideService(Caller, { marker: "request context" }))
  )
  expect(result.status).toBe(200)
  expect(await result.json()).toEqual({ marker: "request context" })
})

it.each([
  [
    new ConnectionError({ message: "Reload this connection." }),
    "Reload this connection.",
  ],
  [
    new ConnectionStorageError({
      operation: "write",
      cause: "private database details",
    }),
    incomplete,
  ],
  [
    new ConnectionTransportError({
      operation: "connect",
      cause: "private provider details",
    }),
    transport,
  ],
])(
  "maps tagged errors without relying on class identity: %s",
  async (error, message) => {
    Object.setPrototypeOf(error, Error.prototype)
    const response = await Effect.runPromise(
      connectionResponse(Effect.fail(error))
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: message })
  }
)

it.each([
  { result: "connected", error: undefined },
  {
    result: "failed",
    error: new ConnectionError({ message: "Authorization did not finish." }),
  },
  {
    result: "failed",
    error: new ConnectionStorageError({
      operation: "save authorization",
      cause: "private storage detail",
    }),
  },
  {
    result: "failed",
    error: new ConnectionTransportError({
      operation: "authorize",
      cause: "private provider detail",
    }),
  },
])(
  "returns OAuth $result to global connection settings",
  async ({ result, error }) => {
    const unexpected = () =>
      Effect.die(new Error("Unexpected connection operation"))
    let received: Request | undefined
    const connections: RemoteConnectionOperations = {
      defaults: unexpected,
      list: unexpected,
      connect: unexpected,
      disconnect: unexpected,
      reconnect: unexpected,
      refresh: unexpected,
      callback: (request) => {
        received = request
        return error ? Effect.fail(error) : Effect.void
      },
      resolve: unexpected,
      call: unexpected,
    }
    const response = await Effect.runPromise(
      connectionRequest(
        connections,
        new Request(
          "https://internal.example/api/agent/connections/callback?state=state-value&code=code-value"
        ),
        "connections/callback",
        "https://app.example.com"
      )
    )
    expect(received?.url).toBe(
      "https://app.example.com/api/agent/connections/callback?state=state-value&code=code-value"
    )
    expect(received?.method).toBe("GET")
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe(
      `/settings/connections?connections=${result}`
    )
    expect(response.headers.get("referrer-policy")).toBe("no-referrer")
  }
)

it("rejects malformed, oversized and invalid connection input before invoking operations", async () => {
  const unexpected = () =>
    Effect.die(new Error("Unexpected connection operation"))
  const connections: RemoteConnectionOperations = {
    defaults: () => Effect.succeed([]),
    list: unexpected,
    connect: unexpected,
    disconnect: unexpected,
    reconnect: unexpected,
    refresh: unexpected,
    callback: unexpected,
    resolve: unexpected,
    call: unexpected,
  }
  for (const body of [
    "private invalid JSON",
    "x".repeat(16_001),
    '{"name":"private invalid schema"}',
  ]) {
    const response = await Effect.runPromise(
      connectionRequest(
        connections,
        new Request("https://app.example.com/connections/add", {
          method: "POST",
          body,
        }),
        "connections/add",
        "https://app.example.com"
      )
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: incomplete })
  }
})

it("uses the same typed validation boundary for remote tool selection", async () => {
  const response = await Effect.runPromise(
    connectionResponse(
      Effect.gen(function* () {
        const input = yield* connectionJson(
          new Request("https://app.example.com/remote-tools", {
            method: "POST",
            body: '{"expectedRevision":0,"names":["private invalid tool"]}',
          })
        )
        return yield* connectionDecode(SelectRemoteTools, input)
      })
    )
  )
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ error: incomplete })
  const selection = { expectedRevision: 2, names: [] }
  const valid = await Effect.runPromise(
    connectionResponse(
      connectionJson(
        new Request("https://app.example.com/remote-tools", {
          method: "POST",
          body: JSON.stringify(selection),
        })
      ).pipe(
        Effect.flatMap((input) => connectionDecode(SelectRemoteTools, input))
      )
    )
  )
  expect(valid.status).toBe(200)
  expect(await valid.json()).toEqual(selection)
})

it("preserves defects even when the defect carries a handled error tag", async () => {
  const defect = new ConnectionError({
    message: "Unexpected invariant failure",
  })
  const result = await Effect.runPromiseExit(
    connectionResponse(Effect.die(defect))
  )
  expect(Exit.isFailure(result) && Cause.hasDies(result.cause)).toBe(true)
  expect(Exit.isFailure(result) && Cause.hasFails(result.cause)).toBe(false)
})

it("preserves cancellation instead of producing a conflict response", async () => {
  const result = await Effect.runPromiseExit(
    connectionResponse(Effect.interrupt)
  )
  expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true)
  expect(Exit.isFailure(result) && Cause.hasFails(result.cause)).toBe(false)
})

it.each(["defect", "interruption"])(
  "does not turn a connection rejection plus %s into HTTP success",
  async (mode) => {
    const cleanup = new Error("Private connection cleanup failure")
    const exit = await Effect.runPromiseExit(
      connectionResponse(
        Effect.fail(
          new ConnectionError({ message: "Connection rejected" })
        ).pipe(
          Effect.ensuring(
            mode === "defect" ? Effect.die(cleanup) : Effect.interrupt
          )
        )
      )
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (mode === "defect")
      expect(
        Exit.isFailure(exit) &&
          exit.cause.reasons.some(
            (reason) => reason._tag === "Die" && reason.defect === cleanup
          )
      ).toBe(true)
    else
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  }
)
