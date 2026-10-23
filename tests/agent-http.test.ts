import { Cause, Effect, Exit, Layer, ManagedRuntime, Schema } from "effect"
import { afterEach, expect, it, vi } from "vitest"

import {
  connectionJson,
  connectionResponse,
} from "../src/access/adapters/connection-http"
import { remoteToolResolution } from "../src/access/adapters/resolution"
import { AccessStore } from "../src/access/adapters/sqlite"
import {
  ConnectionError,
  ConnectionStorageError,
} from "../src/access/connections"
import * as AgentHttp from "../src/agent/adapters/http"
import {
  agentJson,
  agentNative,
  agentResponse,
  AgentRequestInvalid,
  AgentRequestUnavailable,
} from "../src/agent/adapters/http"
import { proxyTerminalRequest } from "../src/agent/adapters/terminal"
import { PersonalAgent } from "../src/agent/worker"
import { appsRequest } from "../src/apps/adapters/http"
import { AppStore } from "../src/apps/adapters/sqlite"
import { AppConflict } from "../src/apps/contracts"
import { makeApps } from "../src/apps/service"
import { stopConversation } from "../src/conversations/commands"
import { ConversationControlTimeout } from "../src/conversations/execution"
import { conversationPump } from "../src/conversations/pump"
import { ConversationStorageError } from "../src/conversations/turns"
import { ModelUnavailable } from "../src/inference/policy"
import { routinesRequest } from "../src/routines/adapters/http"
import { RoutineConflict } from "../src/routines/contracts"
import { conversationFixture } from "./conversation-fixture"
import { database } from "./database"
import { routineFixture } from "./routine-fixture"

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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
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
function fixture(
  retry: () => Effect.Effect<void, ModelUnavailable> = () => Effect.void
) {
  const runtime = ManagedRuntime.make(Layer.empty)
  runtimes.push(runtime)
  const pump = Effect.runSync(conversationFixture())
  const host: PersonalAgent = Object.create(PersonalAgent.prototype)
  const waitUntil = vi.fn<(work: Promise<unknown>) => void>()
  const retrySummary = vi.fn(retry)
  Object.assign(host, {
    actorRuntime: runtime,
    // The actual route now reconciles this host's joined control releases.
    // Retain a real scoped test pump instead of bypassing the production seam.
    conversationPump: conversationPump(
      pump.conversations,
      pump.memory,
      pump.journal,
      pump.execution,
      pump.host
    ),
    familyAdmission: async () => ({
      owner: "fixture",
      modelOwner: "fixture",
      joinedAt: 1,
    }),
    lifecycle: { start: async () => {} },
    ctx: { waitUntil, id: { toString: () => "actor-id" } },
    retrySummary,
  })
  return { host, retrySummary, waitUntil, pump }
}
const retryId = crypto.randomUUID()
const retryRequest = (signal?: AbortSignal) =>
  new Request("https://internal/api/agent/memory/retry", {
    method: "POST",
    body: JSON.stringify({ start: 0, count: 1, operationId: retryId }),
    signal,
  })
const reasonTags = (cause: unknown) =>
  Cause.isCause(cause) ? cause.reasons.map((reason) => reason._tag) : []

function admissionFixture(path: "routines/save" | "apps/interact") {
  const operationId = crypto.randomUUID()
  if (path === "routines/save") {
    const store = routineFixture(database(), () => true).service
    return {
      properties: { routines: store },
      input: {
        id: crypto.randomUUID(),
        operationId,
        expectedRevision: 0,
        title: "Wake boundary fixture",
        prompt: "Review the retained fixture.",
        schedule: { type: "once", at: Date.now() + 3_600_000 },
        status: "active",
      },
      receipt: () => Effect.runSync(store.operationExists(operationId)),
      writes: () => Effect.runSync(store.list()).length,
    }
  }
  const store = makeApps(new AppStore(database(), () => Effect.succeed(true)))
  const draft = Effect.runSync(
    store.save({
      id: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      expectedRevision: 0,
      definition: {
        title: "Wake boundary fixture",
        description: "Retained app values",
        blocks: [
          {
            type: "checklist",
            id: "tasks",
            title: "Tasks",
            items: [{ id: "one", label: "One" }],
          },
        ],
      },
    })
  )
  const app = Effect.runSync(
    store.publish({
      id: draft.id,
      operationId: crypto.randomUUID(),
      expectedRevision: draft.revision,
      version: 1,
    })
  )
  const input = {
    id: app.id,
    operationId,
    expectedRevision: app.revision,
    version: 1,
    action: {
      type: "check" as const,
      blockId: "tasks",
      itemId: "one",
      checked: true,
    },
  }
  return {
    properties: { appService: store },
    input,
    receipt: () => !!Effect.runSync(store.interactionReceipt(input)),
    writes: () => Effect.runSync(store.pending()).length,
  }
}

for (const path of ["routines/save", "apps/interact"] as const) {
  for (const stage of ["prearm", "acknowledgement"] as const) {
    it.each(["defect", "interruption"])(
      `preserves a compound ${stage} %s through the actual ${path} host route`,
      async (mode) => {
        const f = fixture()
        const admission = admissionFixture(path)
        const deadline = Date.now() + 60_000
        Object.assign(f.host, admission.properties, {
          routineRunner: { armDiscovery: async () => deadline },
          appEvents: {
            armDiscovery: async () => deadline,
            wake: async () => {},
          },
        })
        const defect = new Error("private compound wake defect")
        const failure = Effect.failCause(
          Cause.fromReasons([
            Cause.makeFailReason(
              new AgentRequestUnavailable({ operation: stage })
            ),
            mode === "defect"
              ? Cause.makeDieReason(defect)
              : Cause.makeInterruptReason(),
          ])
        )
        const bridge = vi.spyOn(AgentHttp, "agentNative")
        if (stage === "acknowledgement")
          bridge.mockReturnValueOnce(Effect.succeed(deadline))
        bridge.mockReturnValueOnce(failure)
        try {
          await expect(
            f.host.fetch(
              new Request(`https://internal/api/agent/${path}`, {
                method: "POST",
                body: JSON.stringify(admission.input),
              })
            )
          ).rejects.toSatisfy((cause: unknown) =>
            mode === "defect"
              ? Cause.isCause(cause) &&
                cause.reasons.some(
                  (reason) => reason._tag === "Die" && reason.defect === defect
                )
              : reasonTags(cause).includes("Interrupt")
          )
          expect(bridge.mock.calls.map(([operation]) => operation)).toEqual(
            path === "routines/save"
              ? stage === "prearm"
                ? ["arm routine discovery"]
                : ["arm routine discovery", "arm routine discovery"]
              : stage === "prearm"
                ? ["arm app delivery discovery"]
                : ["arm app delivery discovery", "wake app events"]
          )
          // Failed prearm cannot accept work. Failed acknowledgement retains the
          // already committed event/routine and its exact operation receipt.
          expect(admission.receipt()).toBe(stage === "acknowledgement")
          expect(admission.writes()).toBe(stage === "acknowledgement" ? 1 : 0)
        } finally {
          bridge.mockRestore()
        }
      }
    )
  }
}

it("runs the actual host request through one retained runtime and pins its mutation", async () => {
  const f = fixture()
  const response = await f.host.fetch(retryRequest())
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true })
  expect(f.retrySummary).toHaveBeenCalledWith({
    start: 0,
    count: 1,
    operationId: retryId,
  })
  expect(f.waitUntil).toHaveBeenCalledOnce()
  await expect(f.waitUntil.mock.calls[0]?.[0]).resolves.toBe(response)
})
it("records HTTP Stop and revokes access while joined owner release persistence fails", async () => {
  const f = fixture()
  const id = crypto.randomUUID()
  const access = new AccessStore(f.pump.db, () =>
    Effect.succeed([
      { name: "send", description: "Synthetic effect", mode: "ask" },
    ])
  )
  const approvalId = crypto.randomUUID()
  await Effect.runPromise(
    f.pump.store.admit({ operationId: id, text: "hello" })
  )
  await Effect.runPromise(
    access.begin({ id: approvalId, turnId: id, tool: "send", input: "{}" })
  )
  f.pump.db.run(
    "CREATE TRIGGER reject_joined_release BEFORE UPDATE ON chat_turns WHEN json_extract(OLD.control,'$.owner') IS NOT NULL AND json_extract(NEW.control,'$.owner') IS NULL BEGIN SELECT RAISE(ABORT,'release write unavailable'); END"
  )
  const failed = await Effect.runPromiseExit(f.host.conversationPump.run())
  expect(Exit.isFailure(failed)).toBe(true)
  if (Exit.isFailure(failed))
    expect(failed.cause.reasons).toContainEqual(
      expect.objectContaining({
        _tag: "Fail",
        error: expect.any(ConversationStorageError),
      })
    )
  const before = (await Effect.runPromise(f.pump.store.get(id)))!
  expect(before.status).toBe("running")
  expect(before.control?.owner).toBeTruthy()
  const nativeCalls = [...f.pump.events]
  Object.assign(f.host, {
    stopConversation: stopConversation(
      {
        requestStop: (turnId, options) =>
          f.pump.db.transaction(() =>
            Effect.gen(function* () {
              const root = yield* f.pump.store.requestStop(turnId, options)
              if (root) yield* access.cancel(root)
              return root
            })
          ),
      },
      {
        prearm: () => Effect.succeed(Date.now() + 60_000),
        wake: () => Effect.void,
        wakeBackground: () => Effect.void,
        notify: () => Effect.void,
      }
    ),
  })
  const response = await f.host.fetch(
    new Request("https://internal/api/agent/cancel", {
      method: "POST",
      body: JSON.stringify({ operationId: id }),
    })
  )
  expect(response.status).toBe(202)
  expect(await response.json()).toEqual({ ok: true })
  const stopped = (await Effect.runPromise(f.pump.store.get(id)))!
  expect(stopped).toMatchObject({
    status: "stopping",
    control: {
      owner: before.control!.owner,
      deadline: before.control!.deadline,
    },
  })
  expect(stopped.revision).toBeGreaterThan(before.revision)
  expect(await Effect.runPromise(access.get(approvalId))).toMatchObject({
    status: "cancelled",
  })
  expect(f.pump.events).toEqual(nativeCalls)
  // Revocation must not swallow or clear the retained cleanup obligation.
  expect(
    Exit.isFailure(
      await Effect.runPromiseExit(f.host.conversationPump.reconcile())
    )
  ).toBe(true)
  expect((await Effect.runPromise(f.pump.store.get(id)))!.control!.owner).toBe(
    before.control!.owner
  )
  expect(f.pump.events).toEqual(nativeCalls)
})
it("preserves the declared model rejection through the actual host", async () => {
  const f = fixture(() =>
    Effect.fail(new ModelUnavailable({ message: "Select a compatible model." }))
  )
  const response = await f.host.fetch(retryRequest())
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    error: "Select a compatible model.",
    code: "model_unavailable",
  })
})
it("does not turn a tagged host defect into a normal HTTP response", async () => {
  const f = fixture(() =>
    Effect.die(new ModelUnavailable({ message: "private defect" }))
  )
  await expect(f.host.fetch(retryRequest())).rejects.toSatisfy(
    (cause: unknown) => reasonTags(cause).includes("Die")
  )
})
it("does not admit an already aborted host mutation", async () => {
  const f = fixture()
  const controller = new AbortController()
  controller.abort()
  await expect(f.host.fetch(retryRequest(controller.signal))).rejects.toSatisfy(
    (cause: unknown) => reasonTags(cause).includes("Interrupt")
  )
  expect(f.retrySummary).not.toHaveBeenCalled()
})
it.each([undefined, "{", '{"value":2}', "x".repeat(33)])(
  "decodes bounded request JSON with a finite invalid-request error (%s)",
  async (body) => {
    const request = new Request("https://internal/", { method: "POST", body })
    const response = await Effect.runPromise(
      agentResponse(
        agentJson(request, Schema.Struct({ value: Schema.String }), 32).pipe(
          Effect.map(Response.json)
        )
      )
    )
    expect(response.status).toBe(400)
  }
)
it("joins held request cancellation and keeps a failed cleanup fatal", async () => {
  const closing = deferred<void>()
  const entered = deferred<void>()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(17))
    },
    cancel() {
      entered.resolve()
      return closing.promise
    },
  })
  const request = new Request("https://internal/", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit)
  let settled = false
  const result = Effect.runPromiseExit(
    agentResponse(
      agentJson(request, Schema.Unknown, 16).pipe(Effect.map(Response.json))
    )
  ).then((exit) => {
    settled = true
    return exit
  })
  await entered.promise
  expect(settled).toBe(false)
  const cleanup = new Error("reader cleanup failed")
  closing.reject(cleanup)
  const exit = await result
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit))
    expect(exit.cause.reasons).toContainEqual(
      expect.objectContaining({ _tag: "Die", defect: cleanup })
    )
  expect(body.locked).toBe(false)
})
it("preserves interruption accompanied by an expected failure", async () => {
  const exit = await Effect.runPromiseExit(
    agentResponse(
      Effect.failCause(
        Cause.fromReasons([
          Cause.makeFailReason(new AgentRequestInvalid()),
          Cause.makeInterruptReason(),
        ])
      )
    )
  )
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit))
    expect(exit.cause.reasons.map((reason) => reason._tag)).toEqual([
      "Die",
      "Interrupt",
    ])
})
it("keeps native defects and local undeclared failures fatal", async () => {
  const error = new Error("private programming failure")
  for (const reason of [Cause.die(error), Cause.fail(error)]) {
    const exit = await Effect.runPromiseExit(
      agentNative("wake", () => Promise.reject(reason))
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true)
  }
  const response = await Effect.runPromise(
    agentResponse(agentNative("wake", () => Promise.reject(error)))
  )
  expect(response.status).toBe(503)
  expect(JSON.stringify(await response.json())).not.toContain(error.message)
})
it("retains the native Terminal response, upgrade metadata, headers and query", async () => {
  const f = fixture()
  const response = new Response(null, { headers: { "x-terminal": "original" } })
  const socket = { readyState: 1 }
  Object.defineProperty(response, "webSocket", { value: socket })
  const fetch = vi.fn<(request: Request) => Promise<Response>>(
    async () => response
  )
  Object.assign(f.host, { env: { TERMINAL_SERVICE: { fetch } } })
  const returned = await f.host.fetch(
    new Request("https://internal/api/agent/terminal/socket?session=s1")
  )
  expect(returned).toBe(response)
  expect(returned.webSocket).toBe(socket)
  expect(fetch.mock.calls[0]?.[0].url).toBe(
    "https://terminal.internal/actor-id/terminal/socket?session=s1"
  )
})
it("does not dispatch an already cancelled Terminal request", async () => {
  const fetch = vi.fn(async () => new Response())
  const controller = new AbortController()
  controller.abort()
  await expect(
    proxyTerminalRequest(
      new Request("https://internal/api/agent/terminal", {
        signal: controller.signal,
      }),
      { fetch },
      "actor"
    )
  ).rejects.toSatisfy((cause: unknown) =>
    reasonTags(cause).includes("Interrupt")
  )
  expect(fetch).not.toHaveBeenCalled()
})
it("joins a late Terminal response's cleanup before rejecting cancellation", async () => {
  const pending = deferred<Response>(),
    closing = deferred<void>(),
    entered = deferred<void>()
  const controller = new AbortController()
  const response = new Response(
    new ReadableStream({
      cancel() {
        entered.resolve()
        return closing.promise
      },
    })
  )
  const result = proxyTerminalRequest(
    new Request("https://internal/api/agent/terminal", {
      signal: controller.signal,
    }),
    { fetch: () => pending.promise },
    "actor"
  )
  let settled = false
  const observed = result.catch((cause: unknown) => {
    settled = true
    return cause
  })
  controller.abort()
  pending.resolve(response)
  await entered.promise
  expect(settled).toBe(false)
  closing.reject(new Error("body cleanup failed"))
  expect(reasonTags(await observed)).toEqual(["Interrupt", "Die"])
})
it("retains both socket cleanup failures after a cancelled Terminal upgrade", async () => {
  const controller = new AbortController(),
    pending = deferred<Response>()
  const response = new Response(null)
  const accept = vi.fn(() => {
    throw new Error("accept cleanup")
  })
  const close = vi.fn(() => {
    throw new Error("close cleanup")
  })
  Object.defineProperty(response, "webSocket", {
    value: { readyState: 0, accept, close },
  })
  const result = proxyTerminalRequest(
    new Request("https://internal/api/agent/terminal", {
      signal: controller.signal,
    }),
    { fetch: () => pending.promise },
    "actor"
  ).catch((cause: unknown) => cause)
  controller.abort()
  pending.resolve(response)
  expect(reasonTags(await result)).toEqual(["Interrupt", "Die", "Die"])
  expect(accept).toHaveBeenCalledOnce()
  expect(close).toHaveBeenCalledOnce()
})
it("projects only expected tool-resolution failures and keeps tagged defects fatal", async () => {
  for (const error of [
    new ConnectionError({ message: "Select a connected tool." }),
    new ConnectionStorageError({ operation: "read", cause: "private" }),
  ]) {
    const expected = await Effect.runPromise(
      remoteToolResolution(Effect.fail(error))
    )
    expect(expected.tools).toEqual([])
    expect(expected.error).not.toContain("private")
    const fatal = await Effect.runPromiseExit(
      remoteToolResolution(Effect.die(error))
    )
    expect(Exit.isFailure(fatal) && Cause.hasDies(fatal.cause)).toBe(true)
  }
})
it("does not turn connection request cleanup failure into an ordinary conflict", async () => {
  const failure = new Error("connection reader cleanup")
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(16_001))
    },
    cancel() {
      return Promise.reject(failure)
    },
  })
  const request = new Request("https://internal/", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit)
  const exit = await Effect.runPromiseExit(
    connectionResponse(connectionJson(request))
  )
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
})

it("composes app prearm effects without boxing a tagged defect as an HTTP conflict", async () => {
  const store = makeApps(
    new AppStore(database(), () => Effect.sync(() => true))
  )
  const defect = new AppConflict({ message: "private wake defect" })
  const exit = await Effect.runPromiseExit(
    appsRequest(
      store,
      new Request("https://internal/", {
        method: "POST",
        body: JSON.stringify({
          id: crypto.randomUUID(),
          operationId: crypto.randomUUID(),
          version: 1,
          expectedRevision: 0,
          action: {
            type: "check",
            blockId: "tasks",
            itemId: "one",
            checked: true,
          },
        }),
      }),
      "apps/interact",
      () => Effect.die("A failed prearm must not reach the post-commit wake"),
      undefined,
      () => Effect.die(defect)
    )
  )
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit))
    expect(exit.cause.reasons).toContainEqual(
      expect.objectContaining({ _tag: "Die", defect })
    )
  expect(Effect.runSync(store.list())).toEqual([])
})

it("composes routine prearm effects without admitting work after a defect", async () => {
  const store = routineFixture(database(), () => true).service
  const defect = new RoutineConflict({ message: "private wake defect" })
  const exit = await Effect.runPromiseExit(
    routinesRequest(
      store,
      new Request("https://internal/", {
        method: "POST",
        body: JSON.stringify({
          id: crypto.randomUUID(),
          operationId: crypto.randomUUID(),
          expectedRevision: 0,
          title: "Prearm fixture",
          prompt: "Do not accept before discovery is armed.",
          status: "active",
          schedule: { type: "once", at: Date.now() + 3_600_000 },
        }),
      }),
      "routines/save",
      () => Effect.die(defect),
      () => Effect.void
    )
  )
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit))
    expect(exit.cause.reasons).toContainEqual(
      expect.objectContaining({ _tag: "Die", defect })
    )
  expect(Effect.runSync(store.list())).toEqual([])
})

it("bounds the upstream lease, fences unrelated releases and joins unused-channel cleanup", async () => {
  const f = fixture()
  let firstAborted = 0
  let refusedAborted = 0
  const first = new WritableStream<Uint8Array>({
    abort() {
      firstAborted++
    },
  })
  const refused = new WritableStream<Uint8Array>({
    abort() {
      refusedAborted++
    },
  })
  try {
    expect(await f.host.observeUpstream("first", first)).toBe(true)
    expect(await f.host.observeUpstream("refused", refused)).toBe(false)
    expect(refusedAborted).toBe(1)
    await f.host.releaseUpstream("unrelated")
    expect(firstAborted).toBe(0)
  } finally {
    await f.host.releaseUpstream("first")
  }
  expect(firstAborted).toBe(1)
  const next = new WritableStream<Uint8Array>()
  expect(await f.host.observeUpstream("next", next)).toBe(true)
  await f.host.releaseUpstream("next")
})

it("returns an actionable 503 for an unconfirmed Conversation control timeout", async () => {
  const response = await Effect.runPromise(
    agentResponse(
      Effect.fail(new ConversationControlTimeout({ phase: "observe" }))
    )
  )
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({
    error: "This reply could not be confirmed. Check the reply again.",
  })
})
