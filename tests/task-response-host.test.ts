import { Cause, Effect, Layer, ManagedRuntime } from "effect"
import { afterEach, expect, it, vi } from "vitest"

import * as Gateway from "../src/agent/adapters/gateway"
import { PersonalAgent } from "../src/agent/worker"
import { homeAgentId, originalAgent } from "../src/agents/domain"

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
  RpcTarget: class {},
  env: {},
  tracing: undefined,
}))
vi.mock("agents/lifecycle", () => ({
  Lifecycle: class {},
  LifecycleCapability: class {},
}))
vi.mock("agents/harness/pi", () => ({ PiHarness: class {} }))
vi.mock("../src/observability/events", () => ({
  reportHarness: vi.fn(),
  reportInference: vi.fn(),
  reportRecovery: vi.fn(),
  reportService: vi.fn(),
}))

function gate<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const runtimes: ManagedRuntime.ManagedRuntime<never, never>[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
})
function fixture(fetch: (request: Request) => Promise<Response>) {
  const runtime = ManagedRuntime.make(Layer.empty)
  runtimes.push(runtime)
  const host: PersonalAgent = Object.create(PersonalAgent.prototype)
  const profile = originalAgent("")
  const root = {
    agentProfiles: async () => [profile],
    agentProfile: async () => profile,
    configureBot: async () => {},
    fetch: vi.fn(fetch),
  }
  Object.assign(host, {
    actorRuntime: runtime,
    familyAdmission: async () => ({ owner: "owner" }),
    communication: {
      runtime,
      mailbox: { identity: () => Effect.succeed({ bot: homeAgentId }) },
    },
    env: { AGENT: { getByName: () => root } },
    ctx: {
      waitUntil: (work: Promise<unknown>) => {
        void work.catch(() => {})
      },
    },
  })
  return { host, root }
}

it.each(["complete", "fail"])(
  "actual taskAction cancels a held body and joins cleanup until it can %s",
  async (mode) => {
    const reading = gate<void>()
    const cancelling = gate<void>()
    const cleanup = gate<void>()
    const defect = new Error("Task body cleanup failed")
    const cancel = vi.fn(() => {
      cancelling.resolve()
      return cleanup.promise
    })
    const body = new ReadableStream<Uint8Array>(
      { pull: () => reading.resolve(), cancel },
      { highWaterMark: 0 }
    )
    const f = fixture(async () => new Response(body))
    const controller = new AbortController()
    let settled = false
    const running = f.host
      .taskAction({ action: "status" }, undefined, controller.signal)
      .catch((cause: unknown) => cause)
      .finally(() => {
        settled = true
      })
    await reading.promise
    controller.abort()
    await cancelling.promise
    expect(settled).toBe(false)
    expect(body.locked).toBe(true)
    if (mode === "complete") cleanup.resolve()
    else cleanup.reject(defect)
    const cause = await running
    expect(Cause.isCause(cause) && Cause.hasInterrupts(cause)).toBe(true)
    if (mode === "fail")
      expect(Cause.isCause(cause) && cause.reasons).toContainEqual(
        expect.objectContaining({ _tag: "Die", defect })
      )
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
    expect(f.root.fetch).toHaveBeenCalledOnce()
  }
)

it.each(["complete", "fail"])(
  "actual taskAction owns a late gateway response before its reader exists when cleanup will %s",
  async (mode) => {
    const entered = gate<void>()
    const reply = gate<Response>()
    const cancelling = gate<void>()
    const cleanup = gate<void>()
    const defect = new Error("Late response cleanup failed")
    const cancel = vi.fn(() => {
      cancelling.resolve()
      return cleanup.promise
    })
    const body = new ReadableStream<Uint8Array>({ cancel })
    const getReader = vi.spyOn(body, "getReader")
    const f = fixture(async () => Response.json([]))
    const gateway = vi
      .spyOn(Gateway, "agentGateway")
      .mockImplementationOnce(() => {
        entered.resolve()
        return reply.promise
      })
    const controller = new AbortController()
    let settled = false
    const running = f.host
      .taskAction({ action: "status" }, undefined, controller.signal)
      .catch((cause: unknown) => cause)
      .finally(() => {
        settled = true
      })
    try {
      await entered.promise
      controller.abort()
      reply.resolve(new Response(body))
      await cancelling.promise
      expect(settled).toBe(false)
      expect(getReader).not.toHaveBeenCalled()
      if (mode === "complete") cleanup.resolve()
      else cleanup.reject(defect)
      const cause = await running
      expect(Cause.isCause(cause) && Cause.hasInterrupts(cause)).toBe(true)
      if (mode === "fail")
        expect(Cause.isCause(cause) && cause.reasons).toContainEqual(
          expect.objectContaining({ _tag: "Die", defect })
        )
      expect(cancel).toHaveBeenCalledOnce()
      expect(body.locked).toBe(false)
      expect(f.root.fetch).not.toHaveBeenCalled()
    } finally {
      gateway.mockRestore()
    }
  }
)

it("actual taskAction keeps a lone task failure as the prior user-facing reply", async () => {
  const f = fixture(async () => new Response("missing", { status: 404 }))
  expect(
    await f.host.taskAction({ action: "stop", handle: "home/request/missing" })
  ).toBe("This task's state could not be confirmed. Retry the same handle.")
})
