import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context"
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai"
import { Harness, createRegistry } from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import { Effect } from "effect"
import { expect, it } from "vitest"

import { piDelegationLedger } from "../src/delegation/adapters/pi"
import { DelegationFailure } from "../src/delegation/contracts"
import { requestId, restoreGroup } from "../src/delegation/domain"
import { makeDelegations } from "../src/delegation/service"
import { resolveRoute } from "../src/inference/policy"

const run = Effect.runPromise
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
type NativeConversation = NonNullable<
  Awaited<ReturnType<Harness["conversation"]>>
>

async function fixture() {
  const directory = await mkdtemp(
    join(tmpdir(), "delegation-family-revocation-")
  )
  const path = join(directory, "pi.sqlite")
  const models = createModels(),
    registry = createRegistry()
  const provider = fauxProvider({
    provider: "openai",
    models: [
      { id: "test", reasoning: false, contextWindow: 32000, maxTokens: 2000 },
    ],
    tokensPerSecond: 1000000,
  })
  const modelEntered = deferred(),
    submitEntered = deferred(),
    releaseSubmit = deferred()
  const order: string[] = []
  const faults = {
    holdSubmit: false,
    holdModel: false,
    allowDiscovery: false,
    rejectAbort: false,
    rejectCommit: false,
    authority: "allowed" as "allowed" | "cancelled" | "unknown",
  }
  provider.setResponses(
    Array.from({ length: 10 }, (_, index) => async (_input, options) => {
      if (index > 0 && faults.holdModel) {
        modelEntered.resolve()
        await Effect.runPromise(Effect.never, { signal: options?.signal })
      }
      return fauxAssistantMessage(
        index === 0 ? "Parent completed" : "Private child answer"
      )
    })
  )
  models.setProvider(provider.provider)
  registry.install({ name: "reader" })
  const options = {
    models,
    registry,
    settings: { retry: { enabled: false }, compaction: { enabled: false } },
  }
  let harness = await Harness.open(
    await openNodeSqliteStorage(path),
    options,
    ctx
  )
  const parent = await harness.root(ctx, {
    agent: { model: { provider: "openai", modelId: "test" } },
  })
  const parentSubmission = await parent.submit(
    {
      type: "input",
      requestId: "completed-parent",
      content: "Finish this parent request.",
    },
    ctx
  )
  await parentSubmission.wait(ctx)
  const open = async () =>
    new Proxy(harness, {
      get(target, key) {
        if (key === "conversation")
          return async (...args: Parameters<Harness["conversation"]>) => {
            const conversation = await target.conversation(...args)
            if (!conversation) return conversation
            return new Proxy(conversation, {
              get(native, member) {
                if (member === "submit")
                  return async (
                    ...args: Parameters<NativeConversation["submit"]>
                  ) => {
                    order.push("submit-entered")
                    if (faults.holdSubmit) {
                      submitEntered.resolve()
                      await releaseSubmit.promise
                    }
                    const result = await native.submit(...args)
                    order.push("submit-admitted")
                    return result
                  }
                if (member === "abort")
                  return async (
                    ...args: Parameters<NativeConversation["abort"]>
                  ) => {
                    order.push("abort-started")
                    const result = await native.abort(...args)
                    order.push("abort-confirmed")
                    return result
                  }
                const value = Reflect.get(native, member)
                return typeof value === "function" ? value.bind(native) : value
              },
            })
          }
        const value = Reflect.get(target, key)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
  const ledger = piDelegationLedger(
    open,
    () => registry.snapshot().extension("reader")!,
    () => []
  )
  const app = makeDelegations(
    {
      ...ledger,
      atomic: (body) =>
        ledger.atomic((tx) =>
          body(tx).pipe(
            Effect.tap(() =>
              faults.rejectCommit
                ? Effect.fail(
                    new DelegationFailure({
                      code: "unavailable",
                      message: "Synthetic rejected commit",
                    })
                  )
                : Effect.void
            )
          )
        ),
      abort: (child) =>
        faults.rejectAbort
          ? Effect.fail(
              new DelegationFailure({
                code: "unavailable",
                message: "Synthetic abort unavailable",
              })
            )
          : ledger.abort(child),
    },
    {
      current: () => {
        if (faults.authority === "unknown")
          throw new Error("Must not renew authority during cleanup")
        return false // The actual native parent submission completed above.
      },
      cancelled: () => {
        if (faults.authority === "unknown")
          throw new Error("Unknown authority is not Stop")
        return faults.authority === "cancelled"
      },
    },
    Effect.succeed(2000),
    {
      arm: () =>
        faults.allowDiscovery
          ? Effect.succeed(62000)
          : Effect.die("Known revocation must not depend on discovery"),
      wake: () => Effect.die("Known revocation must not depend on a wake"),
    }
  )
  const seed = (count = 1) =>
    run(
      ledger.atomic((tx) =>
        Effect.gen(function* () {
          const tasks = Array.from({ length: count }, (_, index) => ({
            name: `Draft ${index + 1}`,
            task: "Keep private",
            tools: [],
          }))
          const source = {
            detached: true,
            taskId: 7,
            turnId: "completed-parent",
            conversationId: Number(parent.id),
            route: resolveRoute("conversation", {
              model: "test",
              thinking: "off",
            }),
            memory: "Private source",
          }
          const children = []
          for (const task of tasks)
            children.push({
              ...task,
              id: yield* tx.createChild(source, task),
              requests: 0,
              stopped: false,
            })
          const value = restoreGroup({
            id: 7,
            turnId: source.turnId,
            conversationId: source.conversationId,
            detached: true,
            input: { objective: "Draft", tasks },
            route: source.route,
            memory: source.memory,
            createdAt: 1000,
            deadline: 601000,
            revision: 0,
            closed: false,
            children,
            controls: [],
          })
          ;(yield* tx.group(value.id)).value = value
          ;(yield* tx.parent(value.turnId)).group = value.id
          ;(yield* tx.catalog()).ids.push(value.id)
          return value
        })
      )
    )
  return {
    app,
    ledger,
    seed,
    faults,
    order,
    modelEntered,
    submitEntered,
    releaseSubmit,
    reopen: async () => {
      await harness.close(ctx)
      harness = await Harness.open(
        await openNodeSqliteStorage(path),
        options,
        ctx
      )
    },
    close: async () => {
      releaseSubmit.resolve()
      await harness.close(ctx)
      await rm(directory, { recursive: true, force: true })
    },
  }
}

it("known family revocation stops a live detached child after its actual parent completed", async () => {
  const f = await fixture()
  try {
    const saved = await f.seed(),
      child = saved.children[0]!
    f.faults.holdModel = true
    await run(f.app.reconcile(saved.turnId))
    await f.modelEntered.promise
    expect(
      await run(f.ledger.hasSubmission(child.id, requestId(saved, child.id)))
    ).toBe(true)
    f.faults.authority = "unknown"
    await run(f.app.revoke(saved.turnId))
    const revoked = await run(f.ledger.group(saved.id))
    expect(revoked).toMatchObject({
      lifecycle: "closing",
      closed: false,
      children: [
        { id: child.id, lifecycle: "stopping", stopped: true, requests: 0 },
      ],
      controls: [],
    })
    expect(f.order).not.toContain("abort-started")
    await run(f.app.reconcile(saved.turnId, { allowDispatch: false }))
    expect(await run(f.ledger.group(saved.id))).toMatchObject({
      lifecycle: "closed",
      children: [{ id: child.id, lifecycle: "stopped" }],
    })
    expect(f.order.filter((event) => event === "abort-confirmed")).toHaveLength(
      1
    )
    expect(f.order.filter((event) => event === "submit-admitted")).toHaveLength(
      1
    )
    expect(await run(f.app.nextWake())).toBeUndefined()
    const complete = await run(f.ledger.group(saved.id))
    await run(f.app.revoke(saved.turnId))
    await run(f.app.reconcile(saved.turnId, { allowDispatch: false }))
    expect(await run(f.ledger.group(saved.id))).toEqual(complete)
  } finally {
    await f.close()
  }
})

it("unknown authority alone leaves pending detached work unrevoked and undispatched", async () => {
  const f = await fixture()
  try {
    const saved = await f.seed()
    f.faults.authority = "unknown"
    await run(f.app.reconcile(saved.turnId, { allowDispatch: false }))
    expect(await run(f.ledger.group(saved.id))).toEqual(saved)
    expect(f.order).toEqual([])
  } finally {
    await f.close()
  }
})

it("revocation commits all children atomically before native work and survives SQLite reopen", async () => {
  const f = await fixture()
  try {
    const saved = await f.seed(2)
    f.faults.authority = "unknown"
    f.faults.rejectCommit = true
    expect(
      await run(f.app.revoke(saved.turnId).pipe(Effect.result))
    ).toMatchObject({ _tag: "Failure" })
    expect(await run(f.ledger.group(saved.id))).toEqual(saved)
    f.faults.rejectCommit = false
    await run(f.app.revoke(saved.turnId))
    const revoked = await run(f.ledger.group(saved.id))
    expect(revoked.lifecycle).toBe("closing")
    expect(revoked.children.map((child) => child.lifecycle)).toEqual([
      "stopping",
      "stopping",
    ])
    expect(revoked.controls).toEqual([])
    expect(f.order).toEqual([])
    await run(f.app.revoke(saved.turnId))
    expect(await run(f.ledger.group(saved.id))).toEqual(revoked)
    await f.reopen()
    expect(await run(f.ledger.group(saved.id))).toEqual(revoked)
    await run(f.app.restore())
    expect(await run(f.ledger.group(saved.id))).toMatchObject({
      lifecycle: "closed",
      children: [
        { id: saved.children[0]!.id, lifecycle: "stopped" },
        { id: saved.children[1]!.id, lifecycle: "stopped" },
      ],
    })
    expect(f.order.filter((event) => event === "submit-entered")).toHaveLength(
      0
    )
    expect(f.order.filter((event) => event === "abort-confirmed")).toHaveLength(
      2
    )
  } finally {
    await f.close()
  }
})

it("known revocation retains a held native dispatch owner until admission and Stop join", async () => {
  const f = await fixture()
  let dispatch: Promise<void> | undefined, cleanup: Promise<void> | undefined
  try {
    const saved = await f.seed()
    f.faults.holdSubmit = true
    dispatch = run(f.app.reconcile(saved.turnId))
    void dispatch.catch(() => undefined)
    await f.submitEntered.promise
    await run(f.app.revoke(saved.turnId))
    expect(await run(f.ledger.group(saved.id))).toMatchObject({
      lifecycle: "closing",
      children: [{ lifecycle: "stopping" }],
    })
    let joined = false
    cleanup = run(f.app.reconcile(saved.turnId, { allowDispatch: false })).then(
      () => {
        joined = true
        f.order.push("cleanup-joined")
      }
    )
    await setImmediate()
    expect(joined).toBe(false)
    expect(f.order).not.toContain("abort-started")
    f.releaseSubmit.resolve()
    await dispatch
    await cleanup
    expect(f.order.indexOf("submit-admitted")).toBeLessThan(
      f.order.indexOf("abort-started")
    )
    expect(f.order.indexOf("abort-confirmed")).toBeLessThan(
      f.order.indexOf("cleanup-joined")
    )
    expect(f.order.filter((event) => event === "submit-admitted")).toHaveLength(
      1
    )
    expect(await run(f.ledger.group(saved.id))).toMatchObject({
      lifecycle: "closed",
      children: [{ lifecycle: "stopped" }],
    })
    f.faults.authority = "cancelled"
    f.faults.allowDiscovery = true
    expect(
      await run(
        f.app
          .deliverMessage(
            saved.children[0]!.id,
            "Late follow-up",
            "late-message"
          )
          .pipe(Effect.result)
      )
    ).toMatchObject({ _tag: "Failure", failure: { code: "cancelled" } })
    expect(f.order.filter((event) => event === "submit-admitted")).toHaveLength(
      1
    )
  } finally {
    f.releaseSubmit.resolve()
    await Promise.allSettled([
      ...(dispatch ? [dispatch] : []),
      ...(cleanup ? [cleanup] : []),
    ])
    await f.close()
  }
})

it("repeated known revocation does not renew uncertain Stop cleanup", async () => {
  const f = await fixture()
  try {
    const saved = await f.seed()
    f.faults.authority = "unknown"
    await run(f.app.revoke(saved.turnId))
    f.faults.rejectAbort = true
    expect(
      await run(
        f.app
          .reconcile(saved.turnId, { allowDispatch: false })
          .pipe(Effect.result)
      )
    ).toMatchObject({ _tag: "Failure" })
    const uncertain = await run(f.ledger.group(saved.id))
    expect(uncertain).toMatchObject({
      lifecycle: "closing",
      children: [{ lifecycle: "unconfirmed", stopped: true }],
    })
    expect(await run(f.app.nextWake())).toBeUndefined()
    f.faults.rejectAbort = false
    await run(f.app.revoke(saved.turnId))
    await run(f.app.reconcile(saved.turnId, { allowDispatch: false }))
    expect(await run(f.ledger.group(saved.id))).toEqual(uncertain)
    expect(f.order).toEqual([])
  } finally {
    await f.close()
  }
})
