import { Cause, Exit, Schema } from "effect"
import { expect, it, vi } from "vitest"

import { agentGateway } from "../src/agent/adapters/gateway"
import { AgentOutcome } from "../src/agents/adapters/rpc"
import { AgentId, AgentStorageError } from "../src/agents/domain"
import type { AgentProfile } from "../src/agents/domain"
import { reportService } from "../src/observability/events"
import { WebhookAuthorizationOutcome } from "../src/webhooks/adapters/authorization-rpc"
import { WebhookStorageError } from "../src/webhooks/persistence"

vi.mock("../src/observability/events", () => ({ reportService: vi.fn() }))
const profile: AgentProfile = {
  id: Schema.decodeUnknownSync(AgentId)("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
  name: "Bot",
  instructions: "",
  status: "active",
  revision: 1,
  createdAt: "",
  updatedAt: "",
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function fixture() {
  const response = Response.json({ saved: true })
  const root = {
    agentProfile: vi.fn(async () => profile),
    fetch: vi.fn(async (_request: Request) => Response.json([])),
  }
  const target = {
    configureBot: vi.fn(
      async (
        _owner: string,
        _profile: AgentProfile,
        _communicationOwner?: string
      ) => {}
    ),
    fetch: vi.fn(async (_request: Request): Promise<Response> => response),
    webhookAuthorized: vi.fn(async () => false),
  }
  const getByName = vi.fn((name: string) => {
    if (name === "owner") return root
    if (name === `bot:owner:${profile.id}`) return target
    throw new Error("Unexpected namespace address")
  })
  const owned: Promise<unknown>[] = []
  const ctx = {
    waitUntil: (work: Promise<unknown>) => {
      owned.push(work)
      void work.catch(() => {})
    },
  }
  const request = (signal?: AbortSignal, path = "state") =>
    new Request(`https://internal/api/agent/${path}?agent=${profile.id}`, {
      headers: { "x-owner-id": "owner" },
      signal,
    })
  const env = { AGENT: { getByName } }
  return { root, target, env, ctx, request, getByName, owned, response }
}
it("refuses a pre-aborted request before namespace lookup or configuration", async () => {
  const f = fixture(),
    controller = new AbortController()
  controller.abort()
  await expect(
    agentGateway(f.request(controller.signal), f.env, f.ctx)
  ).rejects.toSatisfy(
    (cause: unknown) => Cause.isCause(cause) && Cause.hasInterrupts(cause)
  )
  expect(f.getByName).not.toHaveBeenCalled()
  expect(f.target.configureBot).not.toHaveBeenCalled()
})
it("retains original native response, headers and upgrade metadata after successful forwarding", async () => {
  const f = fixture(),
    socket = { readyState: 1, accept: vi.fn(), close: vi.fn() }
  Object.defineProperty(f.response, "webSocket", { value: socket })
  f.response.headers.set("x-native", "retained")
  expect(await agentGateway(f.request(), f.env, f.ctx)).toBe(f.response)
  expect(f.target.fetch.mock.calls[0]?.[0].url).toBe(f.request().url)
  expect(f.target.configureBot).toHaveBeenCalledWith("owner", profile, "owner")
  expect(socket.close).not.toHaveBeenCalled()
  expect(f.owned).toHaveLength(1)
  expect(await f.response.json()).toEqual({ saved: true })
})
it.each(["expected", "defect", "interrupt", "mixed"])(
  "keeps gateway %s outcomes distinct",
  async (mode) => {
    const f = fixture()
    const error = new AgentStorageError()
    const cause = Cause.fromReasons(
      mode === "expected"
        ? [Cause.makeFailReason(error)]
        : mode === "defect"
          ? [Cause.makeDieReason("Private")]
          : mode === "interrupt"
            ? [Cause.makeInterruptReason(73)]
            : [
                Cause.makeFailReason(error),
                Cause.makeDieReason("Private"),
                Cause.makeInterruptReason(73),
              ]
    )
    Object.assign(f.root, {
      agentV1: async () => AgentOutcome.encode(Exit.failCause(cause)),
    })
    if (mode === "expected") {
      const response = await agentGateway(f.request(), f.env, f.ctx)
      expect(response.status).toBe(503)
      expect(JSON.stringify(await response.json())).not.toContain("Private")
    } else
      await expect(agentGateway(f.request(), f.env, f.ctx)).rejects.toSatisfy(
        (value: unknown) =>
          Cause.isCause(value) &&
          (Cause.hasDies(value) || Cause.hasInterrupts(value))
      )
    expect(f.target.configureBot).not.toHaveBeenCalled()
    expect(f.target.fetch).not.toHaveBeenCalled()
  }
)
it("joins a late forwarded response and held unread-body cleanup after cancellation", async () => {
  const f = fixture(),
    entered = deferred<void>(),
    reply = deferred<Response>(),
    cancelling = deferred<void>(),
    close = deferred<void>(),
    controller = new AbortController()
  f.target.fetch.mockImplementation(async (request) => {
    expect(request.signal.aborted).toBe(false)
    entered.resolve()
    return reply.promise
  })
  let settled = false
  const work = agentGateway(f.request(controller.signal), f.env, f.ctx).then(
    () => {
      settled = true
    },
    (cause: unknown) => {
      settled = true
      return cause
    }
  )
  await entered.promise
  controller.abort()
  reply.resolve(
    new Response(
      new ReadableStream<Uint8Array>({
        cancel: () => {
          cancelling.resolve()
          return close.promise
        },
      })
    )
  )
  await cancelling.promise
  expect(settled).toBe(false)
  const defect = new Error("Private cleanup failure")
  close.reject(defect)
  const cause = await work
  expect(Cause.isCause(cause) && Cause.hasInterrupts(cause)).toBe(true)
  expect(
    Cause.isCause(cause) &&
      cause.reasons.some(
        (reason) => reason._tag === "Die" && reason.defect === defect
      )
  ).toBe(true)
})
it("attempts socket accept, close and body cleanup even when each fails", async () => {
  const f = fixture(),
    entered = deferred<void>(),
    reply = deferred<Response>(),
    controller = new AbortController()
  const accept = new Error("accept"),
    close = new Error("close"),
    body = new Error("body")
  const response = new Response(
    new ReadableStream<Uint8Array>({ cancel: () => Promise.reject(body) })
  )
  const socket = {
    readyState: 1,
    accept: vi.fn(() => {
      throw accept
    }),
    close: vi.fn(() => {
      throw close
    }),
  }
  Object.defineProperty(response, "webSocket", { value: socket })
  f.target.fetch.mockImplementation(() => {
    entered.resolve()
    return reply.promise
  })
  const work = agentGateway(f.request(controller.signal), f.env, f.ctx).catch(
    (cause: unknown) => cause
  )
  await entered.promise
  controller.abort()
  reply.resolve(response)
  const cause = await work
  expect(socket.accept).toHaveBeenCalledOnce()
  expect(socket.close).toHaveBeenCalledOnce()
  expect(
    Cause.isCause(cause) &&
      cause.reasons
        .filter((reason) => reason._tag === "Die")
        .map((reason) => reason.defect)
  ).toEqual([accept, close, body])
  const reported = vi.mocked(reportService).mock.calls.at(-1)?.[0]
  expect(
    Cause.isCause(reported) &&
      reported.reasons
        .filter((reason) => reason._tag === "Die")
        .map((reason) => reason.defect)
  ).toEqual([accept, close, body])
})
it("maps opaque transport rejection to availability without hiding malformed legacy profiles", async () => {
  const f = fixture()
  f.root.agentProfile.mockRejectedValueOnce(new Error("Private transport"))
  expect((await agentGateway(f.request(), f.env, f.ctx)).status).toBe(503)
  Object.assign(f.root, {
    agentProfile: async () => ({ ...profile, revision: "invalid" }),
  })
  await expect(agentGateway(f.request(), f.env, f.ctx)).rejects.toSatisfy(
    (cause: unknown) => Cause.isCause(cause) && Cause.hasDies(cause)
  )
})
it("rejects an unauthorized webhook before configuration or forwarding", async () => {
  const f = fixture()
  const request = new Request(
    `https://internal/api/agent/webhooks/incoming?agent=${profile.id}&routine=${crypto.randomUUID()}`,
    {
      method: "POST",
      headers: {
        "x-owner-id": "owner",
        authorization: `Bearer rpwh_${"a".repeat(64)}`,
      },
      body: "{}",
    }
  )
  expect((await agentGateway(request, f.env, f.ctx)).status).toBe(401)
  expect(f.target.webhookAuthorized).toHaveBeenCalledOnce()
  expect(f.target.configureBot).not.toHaveBeenCalled()
  expect(f.target.fetch).not.toHaveBeenCalled()
})
it("joins finite work and closes its response if host pin registration fails", async () => {
  const f = fixture(),
    cancelled = vi.fn(),
    failure = new Error("Pin registration failed")
  f.target.fetch.mockResolvedValue(
    new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }))
  )
  await expect(
    agentGateway(f.request(), f.env, {
      waitUntil: () => {
        throw failure
      },
    })
  ).rejects.toSatisfy(
    (cause: unknown) =>
      Cause.isCause(cause) &&
      cause.reasons.some(
        (reason) => reason._tag === "Die" && reason.defect === failure
      )
  )
  expect(f.target.fetch).toHaveBeenCalledOnce()
  expect(cancelled).toHaveBeenCalledOnce()
})
it("joins configuration acknowledgement after cancellation and does not forward another request", async () => {
  const f = fixture(),
    entered = deferred<void>(),
    acknowledgement = deferred<void>(),
    controller = new AbortController()
  f.target.configureBot.mockImplementation(() => {
    entered.resolve()
    return acknowledgement.promise
  })
  let settled = false
  const running = agentGateway(f.request(controller.signal), f.env, f.ctx)
    .catch((cause: unknown) => cause)
    .finally(() => {
      settled = true
    })
  await entered.promise
  controller.abort()
  expect(settled).toBe(false)
  acknowledgement.resolve()
  expect(Cause.isCause(await running)).toBe(true)
  expect(f.target.fetch).not.toHaveBeenCalled()
})
it("forwards a mutation body once with the authenticated owner and query", async () => {
  const f = fixture()
  f.target.fetch.mockImplementation(async (request) => {
    expect(request.method).toBe("POST")
    expect(request.headers.get("x-owner-id")).toBe("owner")
    expect(new URL(request.url).searchParams.get("agent")).toBe(profile.id)
    expect(await request.text()).toBe('{"operationId":"synthetic"}')
    return f.response
  })
  const request = new Request(f.request(), {
    method: "POST",
    body: '{"operationId":"synthetic"}',
  })
  expect(await agentGateway(request, f.env, f.ctx)).toBe(f.response)
  expect(f.target.fetch).toHaveBeenCalledOnce()
})
it.each(["expected", "defect", "mixed"])(
  "keeps webhook %s failures distinct from an authorization denial",
  async (mode) => {
    const f = fixture()
    const cause = Cause.fromReasons(
      mode === "expected"
        ? [
            Cause.makeFailReason(
              new WebhookStorageError({
                operation: "read",
                cause: "Private storage",
              })
            ),
          ]
        : mode === "defect"
          ? [Cause.makeDieReason("Private defect")]
          : [
              Cause.makeFailReason(
                new WebhookStorageError({
                  operation: "read",
                  cause: "Private storage",
                })
              ),
              Cause.makeDieReason("Private defect"),
              Cause.makeInterruptReason(73),
            ]
    )
    Object.assign(f.target, {
      webhookAuthorizationV1: async () =>
        WebhookAuthorizationOutcome.encode(Exit.failCause(cause)),
    })
    const request = new Request(
      `https://internal/api/agent/webhooks/incoming?agent=${profile.id}&routine=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      {
        method: "POST",
        headers: {
          "x-owner-id": "owner",
          authorization: `Bearer rpwh_${"a".repeat(64)}`,
        },
        body: "{}",
      }
    )
    if (mode === "expected")
      expect((await agentGateway(request, f.env, f.ctx)).status).toBe(503)
    else
      await expect(agentGateway(request, f.env, f.ctx)).rejects.toSatisfy(
        (value: unknown) => Cause.isCause(value) && Cause.hasDies(value)
      )
    expect(f.target.webhookAuthorized).not.toHaveBeenCalled()
    expect(f.target.configureBot).not.toHaveBeenCalled()
    expect(f.target.fetch).not.toHaveBeenCalled()
  }
)
