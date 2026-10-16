import { afterEach, expect, it, vi } from "vitest"
import { Cause, Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context"
import {
  Harness,
  createRegistry,
  defineTool,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import {
  Type,
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai"
import { AccessGate } from "../src/access/gate"
import { AccessStore } from "../src/access/adapters/sqlite"
import { guardedTools } from "../src/access/adapters/pi"
import {
  ConnectionStorageError,
  ConnectionError,
} from "../src/access/connections"
import { database } from "./database"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})
const tags = (cause: unknown) =>
  Cause.isCause(cause) ? cause.reasons.map((reason) => reason._tag) : []
async function fixture(
  options: {
    controller?: AbortController
    active?: (turn: string) => Effect.Effect<string | undefined>
    execute?: () => Promise<ToolExecutionResult>
    release?: () => void
  } = {}
) {
  const directory = await mkdtemp(join(tmpdir(), "access-callback-"))
  const turn = crypto.randomUUID(),
    controller = options.controller ?? new AbortController()
  const store = new AccessStore(database(), () =>
    Effect.sync(() => [
      { name: "checked", description: "Synthetic operation", mode: "allow" },
    ])
  )
  const gate = new AccessGate(store, () => Effect.sync(() => true))
  const active = vi.fn(() =>
    options.active ? options.active(turn) : Effect.succeed(turn)
  )
  const execute = vi.fn(
    options.execute ??
      (async () => ({ content: [{ type: "text" as const, text: "done" }] }))
  )
  const checked = guardedTools(
    gate,
    active
  )(
    defineTool({
      name: "checked",
      description: "Synthetic operation",
      parameters: Type.Object({}),
      execute,
    })
  )
  const called = deferred<{
    work: Promise<ToolExecutionResult>
    id: string
    retry: () => Promise<ToolExecutionResult>
  }>()
  const registry = createRegistry()
  registry.install({
    name: "driver",
    tools: [
      defineTool({
        name: "driver",
        description: "Call with a real invocation API",
        parameters: Type.Object({}),
        execute: (_args, api, context) => {
          const work = checked.execute({}, api, {
            ...context,
            abortSignal: controller.signal,
          })
          called.resolve({
            work,
            id: String(api.taskId),
            retry: () =>
              checked.execute({}, api, {
                ...context,
                abortSignal: new AbortController().signal,
              }),
          })
          return work
        },
      }),
    ],
  })
  const models = createModels(),
    faux = fauxProvider()
  models.setProvider(faux.provider)
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("driver", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("Finished."),
  ])
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(directory, "pi.sqlite")),
    {
      models,
      registry,
      settings: { retry: { enabled: false }, compaction: { enabled: false } },
    },
    ctx
  )
  const root = await harness.root(ctx, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  })
  const submission = await root.submit(
    {
      type: "input",
      requestId: turn,
      content: [{ type: "text", text: "Run the synthetic operation." }],
    },
    ctx
  )
  const idle = submission.wait(ctx).then(() => root.waitForIdle(ctx))
  cleanups.push(async () => {
    controller.abort()
    options.release?.()
    await idle
    await harness.close(ctx)
    await rm(directory, { recursive: true, force: true })
  })
  return { ...(await called.promise), controller, store, active, execute, idle }
}
it("does not admit a pre-aborted SDK invocation", async () => {
  const controller = new AbortController()
  controller.abort()
  const f = await fixture({ controller })
  await expect(f.work).rejects.toSatisfy((cause: unknown) =>
    tags(cause).includes("Interrupt")
  )
  expect(f.active).not.toHaveBeenCalled()
  expect(f.execute).not.toHaveBeenCalled()
  expect(Effect.runSync(f.store.get(f.id))).toBeUndefined()
})
it("joins authority lookup finalization before its SDK invocation settles", async () => {
  const entered = deferred<void>(),
    cleaning = deferred<void>(),
    release = deferred<void>()
  const f = await fixture({
    active: () =>
      Effect.acquireUseRelease(
        Effect.sync(() => entered.resolve()),
        () => Effect.never,
        () =>
          Effect.promise(() => {
            cleaning.resolve()
            return release.promise
          })
      ),
    release: () => release.resolve(),
  })
  let settled = false
  const observed = f.work.catch((cause: unknown) => {
    settled = true
    return cause
  })
  await entered.promise
  f.controller.abort()
  await cleaning.promise
  expect(settled).toBe(false)
  expect(f.execute).not.toHaveBeenCalled()
  expect(Effect.runSync(f.store.get(f.id))).toBeUndefined()
  release.resolve()
  expect(tags(await observed)).toContain("Interrupt")
})
it("joins a non-cooperative tool, shares its pending invocation and retains the uncertain-outcome fence", async () => {
  const pending = deferred<ToolExecutionResult>(),
    entered = deferred<void>()
  const f = await fixture({
    execute: () => {
      entered.resolve()
      return pending.promise
    },
    release: () => pending.resolve({ content: [] }),
  })
  await entered.promise
  expect(f.retry()).toBe(f.work)
  let settled = false
  const observed = f.work.catch((cause: unknown) => {
    settled = true
    return cause
  })
  f.controller.abort()
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(Effect.runSync(f.store.get(f.id))?.status).toBe("running")
  pending.resolve({ content: [{ type: "text", text: "late result" }] })
  expect(tags(await observed)).toContain("Interrupt")
  await expect(f.retry()).rejects.toSatisfy((cause: unknown) =>
    tags(cause).includes("Fail")
  )
  expect(f.execute).toHaveBeenCalledOnce()
  expect(Effect.runSync(f.store.get(f.id))?.status).toBe("interrupted")
})
it("retains a late tool defect after cancellation and never records a successful receipt", async () => {
  const pending = deferred<ToolExecutionResult>(),
    entered = deferred<void>()
  const f = await fixture({
    execute: () => {
      entered.resolve()
      return pending.promise
    },
    release: () => pending.resolve({ content: [] }),
  })
  const observed = f.work.catch((cause: unknown) => cause)
  await entered.promise
  f.controller.abort()
  pending.reject(Cause.die(new Error("private late tool defect")))
  expect(tags(await observed)).toEqual(["Interrupt", "Die"])
  expect(Effect.runSync(f.store.get(f.id))?.result).toBeNull()
  expect(f.execute).toHaveBeenCalledOnce()
})
it("retains all native tool reasons instead of boxing a compound Cause as one Fail", async () => {
  const failure = Cause.fromReasons([
    Cause.makeFailReason(new ConnectionError({ message: "Reload the tool." })),
    Cause.makeDieReason(new Error("private tool defect")),
    Cause.makeInterruptReason(71),
  ])
  const f = await fixture({ execute: () => Promise.reject(failure) })
  const observed = await f.work.catch((cause: unknown) => cause)
  expect(tags(observed)).toEqual(["Fail", "Die", "Interrupt"])
  expect(String(observed)).not.toContain("private tool defect")
  expect(Effect.runSync(f.store.get(f.id))?.result).toBeNull()
})

it("keeps private storage diagnostics out of Pi's native error rendering", async () => {
  const failure = new ConnectionStorageError({
    operation: "read owner tool",
    cause: new Error("synthetic-private-detail"),
  })
  const f = await fixture({
    execute: () => Promise.reject(Cause.fail(failure)),
  })
  const observed = await f.work.catch((cause: unknown) => cause)
  expect(tags(observed)).toEqual(["Fail"])
  expect(String(observed)).not.toContain("synthetic-private-detail")
  expect(Cause.isCause(observed) && observed.reasons).toMatchObject([
    {
      _tag: "Fail",
      error: { _tag: "ConnectionStorageError", operation: "read owner tool" },
    },
  ])
})
