import { expect, it, vi } from "vitest"
import { Cause, Effect } from "effect"
import {
  agentProxy,
  type AgentProxyBindings,
} from "../src/auth/adapters/agent-proxy"
import { OwnerSessionUnavailable } from "../src/auth/owner-session"
import type { sessionSocketResponse } from "../src/auth/adapters/session-socket"

vi.mock("../src/observability/events", () => ({ reportService: vi.fn() }))
const user = { id: "owner" }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function fixture() {
  const lookup = vi.fn<
    () => Effect.Effect<typeof user | null, OwnerSessionUnavailable>
  >(() => Effect.succeed(user))
  const response = new Response("Synthetic result", {
    headers: { "x-source": "retained" },
  })
  const close = vi.fn()
  const connected = new Response(null)
  Object.defineProperty(connected, "status", { value: 101 })
  const connect = vi.fn<typeof sessionSocketResponse>(() => ({
    response: connected,
    close,
  }))
  const forward = vi.fn(
    async (_request: Request): Promise<Response> => response
  )
  const owned: Promise<unknown>[] = []
  const bindings: AgentProxyBindings = {
    appUrl: "https://app.example",
    owner: Effect.suspend(lookup),
    forward,
    own: (work) => {
      owned.push(work)
      void work.catch(() => {})
    },
    connect,
  }
  const request = (init: RequestInit = {}) =>
    new Request("https://app.example/api/agent/state?agent=home", init)
  return {
    lookup,
    response,
    close,
    connected,
    connect,
    forward,
    owned,
    bindings,
    request,
  }
}
function upgrade() {
  const response = new Response(null)
  const socket = { readyState: 1, accept: vi.fn(), close: vi.fn() }
  Object.defineProperty(response, "status", { value: 101 })
  Object.defineProperty(response, "webSocket", { value: socket })
  return { response, socket }
}
const upgradedRequest = (signal?: AbortSignal) =>
  new Request("https://app.example/api/agent/terminal/sessions/test/socket", {
    headers: { origin: "https://app.example", upgrade: "websocket" },
    signal,
  })
it("forwards only the authenticated identity and owned headers, preserving body/query and private response headers", async () => {
  const f = fixture()
  f.forward.mockImplementation(async (request) => {
    expect(request.url).toBe(
      "https://agent.internal/api/agent/state?agent=home"
    )
    expect(request.method).toBe("POST")
    expect(Object.fromEntries(request.headers)).toEqual({
      "content-type": "application/json",
      "x-app-origin": "https://app.example",
      "x-owner-id": "owner",
    })
    expect(await request.text()).toBe('{"operationId":"synthetic"}')
    return f.response
  })
  const response = await agentProxy(
    f.request({
      method: "POST",
      body: '{"operationId":"synthetic"}',
      headers: {
        origin: "https://app.example",
        "content-type": "application/json",
        cookie: "synthetic-cookie",
        authorization: "synthetic-bearer",
        "x-owner-id": "forged",
        "x-untrusted": "ignored",
      },
    }),
    f.bindings
  )
  expect(response.headers.get("cache-control")).toBe("private, no-store")
  expect(response.headers.get("x-content-type-options")).toBe("nosniff")
  expect(response.headers.get("x-source")).toBe("retained")
  expect(await response.text()).toBe("Synthetic result")
  expect(f.owned).toHaveLength(1)
})
it("rejects foreign mutation/upgrade origins before session lookup or forwarding", async () => {
  const f = fixture()
  const foreignHeaders: Record<string, string>[] = [
    { origin: "https://other.example" },
    { origin: "https://other.example", upgrade: "websocket" },
  ]
  for (const headers of foreignHeaders)
    expect(
      (
        await agentProxy(
          f.request({ method: headers.upgrade ? "GET" : "POST", headers }),
          f.bindings
        )
      ).status
    ).toBe(403)
  expect(f.lookup).not.toHaveBeenCalled()
  expect(f.forward).not.toHaveBeenCalled()
})
it("rejects anonymous access and unavailable sessions before protected work", async () => {
  const f = fixture()
  f.lookup.mockReturnValueOnce(Effect.succeed(null))
  expect((await agentProxy(f.request(), f.bindings)).status).toBe(401)
  f.lookup.mockReturnValueOnce(
    Effect.fail(
      new OwnerSessionUnavailable({ cause: "Private session details" })
    )
  )
  const response = await agentProxy(f.request(), f.bindings)
  expect(response.status).toBe(503)
  expect(JSON.stringify(await response.json())).not.toContain("Private")
  expect(f.forward).not.toHaveBeenCalled()
})
it("does not admit a pre-aborted lookup or forward", async () => {
  const f = fixture(),
    controller = new AbortController()
  controller.abort()
  await expect(
    agentProxy(f.request({ signal: controller.signal }), f.bindings)
  ).rejects.toSatisfy(
    (cause: unknown) => Cause.isCause(cause) && Cause.hasInterrupts(cause)
  )
  expect(f.lookup).not.toHaveBeenCalled()
  expect(f.forward).not.toHaveBeenCalled()
})
it("maps opaque forwarding failure to a safe availability response", async () => {
  const f = fixture()
  f.forward.mockRejectedValue(new Error("Private transport details"))
  const response = await agentProxy(f.request(), f.bindings)
  expect(response.status).toBe(503)
  expect(JSON.stringify(await response.json())).not.toContain("Private")
})
it.each(["defect", "interruption", "mixed"])(
  "preserves a full native %s instead of returning availability",
  async (mode) => {
    const f = fixture()
    const cause = Cause.fromReasons(
      mode === "defect"
        ? [Cause.makeDieReason("Private")]
        : mode === "interruption"
          ? [Cause.makeInterruptReason(73)]
          : [
              Cause.makeFailReason(
                new OwnerSessionUnavailable({ cause: "Private" })
              ),
              Cause.makeDieReason("Private"),
              Cause.makeInterruptReason(73),
            ]
    )
    f.forward.mockRejectedValue(cause)
    await expect(agentProxy(f.request(), f.bindings)).rejects.toSatisfy(
      (result: unknown) =>
        Cause.isCause(result) &&
        (Cause.hasDies(result) || Cause.hasInterrupts(result))
    )
  }
)
it.each(["closed", "failed"])(
  "joins a late forwarded body and %s cancellation acknowledgement",
  async (mode) => {
    const f = fixture(),
      entered = deferred<void>(),
      reply = deferred<Response>(),
      cancelling = deferred<void>(),
      closed = deferred<void>(),
      controller = new AbortController()
    f.forward.mockImplementation(() => {
      entered.resolve()
      return reply.promise
    })
    let settled = false
    const running = agentProxy(
      f.request({ signal: controller.signal }),
      f.bindings
    )
      .catch((cause: unknown) => cause)
      .finally(() => {
        settled = true
      })
    await entered.promise
    controller.abort()
    reply.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel: () => {
            cancelling.resolve()
            return closed.promise
          },
        })
      )
    )
    await cancelling.promise
    expect(settled).toBe(false)
    const failure = new Error("Body cleanup failed")
    if (mode === "failed") closed.reject(failure)
    else closed.resolve()
    const cause = await running
    expect(Cause.isCause(cause) && Cause.hasInterrupts(cause)).toBe(true)
    if (mode === "failed")
      expect(
        Cause.isCause(cause) &&
          cause.reasons.some(
            (reason) => reason._tag === "Die" && reason.defect === failure
          )
      ).toBe(true)
  }
)
it("closes an acquired upgrade if fresh owner validation was revoked before handoff", async () => {
  const f = fixture(),
    upstream = upgrade()
  f.lookup
    .mockReturnValueOnce(Effect.succeed(user))
    .mockReturnValueOnce(Effect.succeed(null))
  f.forward.mockResolvedValue(upstream.response)
  expect((await agentProxy(upgradedRequest(), f.bindings)).status).toBe(401)
  expect(upstream.socket.accept).toHaveBeenCalledOnce()
  expect(upstream.socket.close).toHaveBeenCalledOnce()
  expect(f.connect).not.toHaveBeenCalled()
})
it("hands off the socket resource and owns every fresh session recheck", async () => {
  const f = fixture(),
    upstream = upgrade()
  f.forward.mockResolvedValue(upstream.response)
  expect(await agentProxy(upgradedRequest(), f.bindings)).toBe(f.connected)
  expect(f.lookup).toHaveBeenCalledTimes(2)
  expect(f.close).not.toHaveBeenCalled()
  const recheck = f.connect.mock.calls[0]?.[1]
  if (!recheck) throw new Error("Session recheck callback missing")
  f.lookup.mockReturnValueOnce(Effect.succeed(null))
  expect(await recheck()).toBe(false)
  expect(f.owned).toHaveLength(2)
})
it("closes the created session bridge if cancellation wins during construction", async () => {
  const f = fixture(),
    upstream = upgrade(),
    controller = new AbortController()
  f.forward.mockResolvedValue(upstream.response)
  f.connect.mockImplementation(() => {
    controller.abort()
    return { response: f.connected, close: f.close }
  })
  await expect(
    agentProxy(upgradedRequest(controller.signal), f.bindings)
  ).rejects.toSatisfy(
    (cause: unknown) => Cause.isCause(cause) && Cause.hasInterrupts(cause)
  )
  expect(f.close).toHaveBeenCalledOnce()
})
it("retains construction defects instead of treating them as transport outages", async () => {
  const f = fixture(),
    upstream = upgrade(),
    defect = new Error("Constructor failed")
  f.forward.mockResolvedValue(upstream.response)
  f.connect.mockImplementation(() => {
    throw defect
  })
  await expect(agentProxy(upgradedRequest(), f.bindings)).rejects.toSatisfy(
    (cause: unknown) =>
      Cause.isCause(cause) &&
      cause.reasons.some(
        (reason) => reason._tag === "Die" && reason.defect === defect
      )
  )
  expect(upstream.socket.close).toHaveBeenCalledOnce()
})
it.each(["identity", "gzip"])(
  "joins work and closes the %s reply after failed host work registration",
  async (encoding) => {
    const f = fixture(),
      closed = vi.fn(),
      defect = new Error("Registration failed")
    f.forward.mockResolvedValue(
      new Response(new ReadableStream<Uint8Array>({ cancel: closed }), {
        headers: { "content-type": "text/event-stream" },
      })
    )
    await expect(
      agentProxy(f.request({ headers: { "accept-encoding": encoding } }), {
        ...f.bindings,
        own: () => {
          throw defect
        },
      })
    ).rejects.toSatisfy(
      (cause: unknown) =>
        Cause.isCause(cause) &&
        cause.reasons.some(
          (reason) => reason._tag === "Die" && reason.defect === defect
        )
    )
    expect(closed).toHaveBeenCalledOnce()
  }
)
it("retains response projection defects and releases their native body", async () => {
  const f = fixture(),
    closed = vi.fn(),
    response = new Response(new ReadableStream<Uint8Array>({ cancel: closed }))
  Object.defineProperty(response, "status", { value: 0 })
  f.forward.mockResolvedValue(response)
  await expect(agentProxy(f.request(), f.bindings)).rejects.toSatisfy(
    (cause: unknown) => Cause.isCause(cause) && Cause.hasDies(cause)
  )
  expect(closed).toHaveBeenCalledOnce()
})
