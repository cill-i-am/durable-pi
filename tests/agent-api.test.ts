import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Scope,
} from "effect"
import { HttpServer } from "effect/http"
import { HttpApiTest, OpenApi } from "effect/http-api"
import { afterEach, expect, it, vi } from "vitest"

import {
  AgentCatalogHttp,
  agentCatalogHttp,
  agentQueryHandlers,
} from "../src/agents/adapters/http-api"
import { AgentQueryApi } from "../src/agents/api"
import { AgentCatalog } from "../src/agents/catalog"
import {
  AgentStorageError,
  homeAgentId,
  type AgentProfile,
} from "../src/agents/domain"
import { nativeOperation } from "../src/shared/interop"

const profile: AgentProfile = {
  id: homeAgentId,
  name: "Home",
  instructions: "",
  revision: 0,
  status: "active",
  createdAt: "",
  updatedAt: "",
}
const runtimes: ManagedRuntime.ManagedRuntime<AgentCatalogHttp, never>[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
})
function fixture() {
  const list = vi.fn<AgentCatalog["Service"]["list"]>(() =>
    Effect.succeed([profile])
  )
  const unexpected = () => Effect.die("Unexpected catalog command")
  const catalog = Layer.succeed(AgentCatalog, {
    list,
    requireActive: unexpected,
    create: unexpected,
    update: unexpected,
    archive: unexpected,
  })
  const runtime = ManagedRuntime.make(
    agentCatalogHttp.pipe(Layer.provide(catalog))
  )
  runtimes.push(runtime)
  return {
    list,
    catalog,
    runtime,
    request: () =>
      runtime.runPromise(
        Effect.flatMap(AgentCatalogHttp, (api) =>
          api.request(new Request("https://agent.internal/api/agent/bots"))
        )
      ),
  }
}
it("serves the existing catalog wire shape through a retained HttpApi router", async () => {
  const f = fixture()
  const response = await f.request()
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ agents: [profile] })
  expect(f.list).toHaveBeenCalledOnce()
})
it("derives and exercises a typed client from the same contract", async () => {
  const f = fixture()
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* HttpApiTest.groups(AgentQueryApi, ["agents"])
        return yield* client.agents.list()
      })
    ).pipe(
      Effect.provide(agentQueryHandlers.pipe(Layer.provide(f.catalog))),
      Effect.provide(HttpServer.layerServices)
    )
  )
  expect(result).toEqual({ agents: [profile] })
  const api = OpenApi.fromApi(AgentQueryApi)
  expect(api.paths["/api/agent/bots"]?.get?.responses).toHaveProperty("400")
})
it("retains the existing safe expected-failure response", async () => {
  const f = fixture()
  f.list.mockImplementation(() => Effect.fail(new AgentStorageError()))
  const response = await f.request()
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    error: "The request could not be completed. Your saved messages are safe.",
  })
})
it.each(["defect", "interrupt", "mixed"])(
  "does not let HttpApi encoding flatten a catalog %s",
  async (mode) => {
    const f = fixture()
    const cause = Cause.fromReasons<AgentStorageError>(
      mode === "defect"
        ? [Cause.makeDieReason("Private catalog defect")]
        : mode === "interrupt"
          ? [Cause.makeInterruptReason(73)]
          : [
              Cause.makeFailReason(new AgentStorageError()),
              Cause.makeDieReason("Private catalog defect"),
              Cause.makeInterruptReason(73),
            ]
    )
    f.list.mockImplementation(() => Effect.failCause(cause))
    const exit = await f.runtime.runPromiseExit(
      Effect.flatMap(AgentCatalogHttp, (api) =>
        api.request(new Request("https://agent.internal/api/agent/bots"))
      )
    )
    expect(
      Exit.isFailure(exit) &&
        (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause))
    ).toBe(true)
  }
)
it("keeps malformed catalog results fatal at response encoding", async () => {
  const f = fixture()
  f.list.mockImplementation(() =>
    Effect.succeed([{ ...profile, createdAt: "", name: "" }])
  )
  const exit = await f.runtime.runPromiseExit(
    Effect.flatMap(AgentCatalogHttp, (api) =>
      api.request(new Request("https://agent.internal/api/agent/bots"))
    )
  )
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
})
it("uses a fresh request scope rather than retaining request cleanup in the actor", async () => {
  const f = fixture()
  let released = 0
  f.list.mockImplementation(() =>
    Effect.withFiber((fiber) => {
      const scope = Context.getOption(fiber.context, Scope.Scope)
      if (scope._tag === "None") return Effect.die("Missing request scope")
      return Scope.addFinalizer(
        scope.value,
        Effect.sync(() => {
          released++
        })
      ).pipe(Effect.as([profile]))
    })
  )
  await f.request()
  expect(released).toBe(1)
  await f.request()
  expect(released).toBe(2)
})
it("joins an admitted native catalog operation after request cancellation", async () => {
  const f = fixture()
  let enter!: () => void, finish!: () => void
  const entered = new Promise<void>((done) => {
    enter = done
  })
  const reply = new Promise<AgentProfile[]>((done) => {
    finish = () => done([profile])
  })
  f.list.mockImplementation(() =>
    nativeOperation(
      () => {
        enter()
        return reply
      },
      () => new AgentStorageError()
    )
  )
  const controller = new AbortController()
  let settled = false
  const work = f.runtime
    .runPromiseExit(
      Effect.flatMap(AgentCatalogHttp, (api) =>
        api.request(new Request("https://agent.internal/api/agent/bots"))
      ),
      { signal: controller.signal }
    )
    .finally(() => {
      settled = true
    })
  await entered
  controller.abort()
  expect(settled).toBe(false)
  finish()
  const exit = await work
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
})
it("keeps concurrent request context separate from the retained handler graph", async () => {
  class Caller extends Context.Service<Caller, string>()("AgentApiCaller") {}
  const f = fixture()
  let release!: () => void,
    entered = 0
  const ready = new Promise<void>((done) => {
    release = done
  })
  f.list.mockImplementation(() =>
    Effect.withFiber((fiber) => {
      const caller = Context.getOption(fiber.context, Caller)
      if (caller._tag === "None") return Effect.die("Missing caller")
      if (++entered === 2) release()
      return nativeOperation(
        () => ready.then(() => [{ ...profile, name: caller.value }]),
        () => new AgentStorageError()
      )
    })
  )
  const call = (name: string) =>
    f.runtime.runPromise(
      Effect.flatMap(AgentCatalogHttp, (api) =>
        api.request(new Request("https://agent.internal/api/agent/bots"))
      ).pipe(Effect.provideService(Caller, name))
    )
  const replies = await Promise.all([call("First"), call("Second")])
  expect(await replies[0].json()).toEqual({
    agents: [{ ...profile, name: "First" }],
  })
  expect(await replies[1].json()).toEqual({
    agents: [{ ...profile, name: "Second" }],
  })
})
