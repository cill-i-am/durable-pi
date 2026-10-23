import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context"
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai"
import {
  Harness,
  createRegistry,
  type ConversationId,
} from "@earendil-works/pi-durable"
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory"
import { Cause, Effect, Exit, Schema } from "effect"
import { expect, it } from "vitest"

import { piDelegationLedger } from "../src/delegation/adapters/pi"
import { DelegationFailure, type Control } from "../src/delegation/contracts"
import type { DelegationRecovery } from "../src/delegation/delegations"
import { restoreGroup, requestId, SavedGroup } from "../src/delegation/domain"
import { advanceChild, advanceGroup } from "../src/delegation/group.machine"
import { makeDelegations } from "../src/delegation/service"
import { resolveRoute } from "../src/inference/policy"

const authority = { current: () => true, cancelled: () => false }
const unknownAuthority = {
  current: () => {
    throw new Error("Cleanup must not renew dispatch authority")
  },
  cancelled: () => {
    throw new Error(
      "Cleanup must not interpret unknown authority as cancellation"
    )
  },
}
const unavailable = () =>
  new DelegationFailure({
    code: "unavailable",
    message: "Recovery unavailable",
  })
const modelFixture = async () => {
  const models = createModels(),
    registry = createRegistry()
  const provider = fauxProvider({
    provider: "openai",
    models: [
      { id: "test", reasoning: false, contextWindow: 32000, maxTokens: 2000 },
    ],
    tokensPerSecond: 1000000,
  })
  provider.setResponses([fauxAssistantMessage("Private answer")])
  models.setProvider(provider.provider)
  registry.install({ name: "reader" })
  const h = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      settings: { retry: { enabled: false }, compaction: { enabled: false } },
    },
    ctx
  )
  const ledger = piDelegationLedger(
    async () => h,
    () => registry.snapshot().extension("reader")!,
    () => []
  )
  const parent = await h.root(ctx)
  const task = { name: "Draft", task: "Keep private", tools: [] }
  const source = {
    detached: true,
    taskId: 7,
    turnId: "recovery-root",
    conversationId: Number(parent.id),
    route: resolveRoute("conversation", { model: "test", thinking: "off" }),
    memory: "Private source",
  }
  const seed = () =>
    Effect.runPromise(
      ledger.atomic((tx) =>
        Effect.gen(function* () {
          const child = yield* tx.createChild(source, task)
          const value = restoreGroup({
            id: 7,
            turnId: source.turnId,
            conversationId: source.conversationId,
            detached: true,
            input: { objective: "Draft", tasks: [task] },
            route: source.route,
            memory: source.memory,
            createdAt: 1000,
            deadline: 601000,
            revision: 0,
            closed: false,
            children: [{ ...task, id: child, requests: 0, stopped: false }],
            controls: [],
          })
          ;(yield* tx.group(7)).value = value
          ;(yield* tx.parent(value.turnId)).group = 7
          ;(yield* tx.catalog()).ids.push(7)
          return value
        })
      )
    )
  return { h, ledger, source, task, seed }
}
const stopFor = (group: SavedGroup): Control => ({
  groupId: group.id,
  childId: group.children[0]!.id,
  operationId: "00000000-0000-4000-8000-000000000010",
  action: { type: "stop" },
})
const run = Effect.runPromise

it("legacy conversion preserves immutable identities and restores stopped cleanup conservatively", async () => {
  const f = await modelFixture()
  try {
    const saved = await f.seed()
    const legacy = {
      ...saved,
      schemaVersion: undefined,
      workflowVersion: undefined,
      lifecycle: undefined,
      dispatches: undefined,
      closed: true,
      children: saved.children.map((child) => ({
        ...child,
        lifecycle: undefined,
        stopped: true,
      })),
    }
    const restored = restoreGroup(legacy)
    expect(restored).toMatchObject({
      id: saved.id,
      turnId: saved.turnId,
      conversationId: saved.conversationId,
      input: saved.input,
      route: saved.route,
      memory: saved.memory,
      lifecycle: "closing",
      closed: false,
      children: [{ id: saved.children[0]!.id, lifecycle: "stopping" }],
      dispatches: [
        { request: requestId(saved, saved.children[0]!.id), state: "accepted" },
      ],
    })
    expect(restoreGroup(restored)).toBe(restored)
    expect(() =>
      Schema.decodeUnknownSync(SavedGroup)({ ...saved, schemaVersion: 2 })
    ).toThrow()
    expect(() => restoreGroup({ ...saved, closed: true })).toThrow(
      "projection conflicts"
    )
    expect(() =>
      restoreGroup({ ...saved, workflowVersion: undefined })
    ).toThrow("Incomplete")
    expect(() =>
      advanceGroup(saved, { type: "CLEANED", unknown: true } as never)
    ).toThrow()
    expect(() =>
      advanceChild(saved, saved.children[0]!.id, {
        type: "REQUEST",
        authorized: "yes",
      } as never)
    ).toThrow()
    expect(advanceGroup(saved, { type: "CLEANED" })).toBe(saved)
  } finally {
    await f.h.close(ctx)
  }
})

it.each(["restore", "cleanup-only"] as const)(
  "%s leaves active detached admission pending without authority or native dispatch",
  async (operation) => {
    const f = await modelFixture()
    try {
      const saved = await f.seed()
      const app = makeDelegations(
        {
          ...f.ledger,
          submit: () => Effect.die("Unexpected native admission"),
        },
        unknownAuthority,
        Effect.succeed(2000)
      )
      await run(
        operation === "restore"
          ? app.restore()
          : app.reconcile(saved.turnId, { allowDispatch: false })
      )
      expect(await run(f.ledger.group(7))).toEqual(saved)
      expect(await run(app.nextWake())).toBe(3000)
    } finally {
      await f.h.close(ctx)
    }
  }
)

it("cleanup-only expiry revokes and joins native Stop without reading unknown authority", async () => {
  const f = await modelFixture()
  try {
    const saved = await f.seed()
    let aborts = 0
    const app = makeDelegations(
      {
        ...f.ledger,
        abort: (child) =>
          Effect.sync(() => {
            aborts++
          }).pipe(Effect.andThen(f.ledger.abort(child))),
        submit: () => Effect.die("Unexpected native admission"),
      },
      unknownAuthority,
      Effect.succeed(saved.deadline)
    )
    await run(app.reconcile(saved.turnId, { allowDispatch: false }))
    expect(aborts).toBe(1)
    expect(await run(f.ledger.group(7))).toMatchObject({
      lifecycle: "closed",
      closed: true,
      children: [{ lifecycle: "stopped", stopped: true }],
    })
    expect(await run(app.nextWake())).toBeUndefined()
  } finally {
    await f.h.close(ctx)
  }
})

it("uncertain Stop remains separate from closure and retries only the original explicit operation", async () => {
  const f = await modelFixture()
  try {
    const saved = await f.seed(),
      stop = stopFor(saved)
    let aborts = 0
    const app = makeDelegations(
      {
        ...f.ledger,
        abort: (child) =>
          Effect.suspend(() =>
            ++aborts === 1 ? unavailable() : f.ledger.abort(child)
          ),
      },
      unknownAuthority,
      Effect.succeed(2000)
    )
    expect(await run(app.control(stop).pipe(Effect.result))).toMatchObject({
      _tag: "Failure",
      failure: { code: "unavailable" },
    })
    expect(await run(f.ledger.group(7))).toMatchObject({
      closed: false,
      children: [{ lifecycle: "unconfirmed", stopped: true }],
    })
    expect(await run(f.ledger.operation(stop.operationId))).toMatchObject({
      applied: false,
    })
    expect(await run(app.nextWake())).toBeUndefined()
    await run(app.reconcile(saved.turnId, { allowDispatch: false }))
    expect(aborts).toBe(1)
    expect(await run(app.control(stop))).toEqual({ accepted: false })
    expect(aborts).toBe(2)
    await run(app.reconcile(saved.turnId, { allowDispatch: false }))
    expect(await run(f.ledger.group(7))).toMatchObject({
      closed: true,
      children: [{ lifecycle: "stopped" }],
    })
  } finally {
    await f.h.close(ctx)
  }
})

it.each([
  "arm-failure",
  "expired-lease",
  "wake-failure",
  "fatal-wake",
] as const)(
  "Stop revokes and joins native cleanup despite %s",
  async (scenario) => {
    const f = await modelFixture()
    try {
      const saved = await f.seed(),
        stop = stopFor(saved)
      const fatal = new Error("Scheduler invariant")
      const recovery: DelegationRecovery = {
        arm: () =>
          scenario === "arm-failure"
            ? unavailable()
            : Effect.succeed(scenario === "expired-lease" ? 1000 : 60000),
        wake: () =>
          scenario === "wake-failure"
            ? unavailable()
            : scenario === "fatal-wake"
              ? Effect.die(fatal)
              : Effect.void,
      }
      const app = makeDelegations(
        f.ledger,
        unknownAuthority,
        Effect.succeed(2000),
        recovery
      )
      const result = await Effect.runPromiseExit(app.control(stop))
      expect(Exit.isFailure(result)).toBe(true)
      if (scenario === "fatal-wake")
        expect(
          Exit.isFailure(result) &&
            result.cause.reasons.some(
              (reason) => reason._tag === "Die" && reason.defect === fatal
            )
        ).toBe(true)
      else
        expect(Exit.isFailure(result) && Cause.hasFails(result.cause)).toBe(
          true
        )
      expect(await run(f.ledger.group(7))).toMatchObject({
        children: [{ lifecycle: "stopped", stopped: true }],
      })
      expect(await run(f.ledger.operation(stop.operationId))).toMatchObject({
        applied: true,
      })
      expect(
        await run(
          f.ledger.hasSubmission(
            saved.children[0]!.id,
            requestId(saved, saved.children[0]!.id)
          )
        )
      ).toBe(false)
    } finally {
      await f.h.close(ctx)
    }
  }
)

it("an expired discovery lease after native child allocation rolls back the real acceptance transaction", async () => {
  const f = await modelFixture()
  try {
    let now = 1000,
      allocated: number | undefined
    const ledger = {
      ...f.ledger,
      atomic: <A, E, R>(
        body: (
          tx: import("../src/delegation/ledger").DelegationTransaction
        ) => Effect.Effect<A, E, R>
      ) =>
        f.ledger.atomic((tx) =>
          body({
            ...tx,
            owner: () =>
              Effect.succeed({
                conversationId: f.source.conversationId,
                abortRequested: false,
              }),
            createChild: (source, task) =>
              tx.createChild(source, task).pipe(
                Effect.tap((id) =>
                  Effect.sync(() => {
                    allocated = id
                    now = 3000
                  })
                )
              ),
          })
        ),
    }
    const app = makeDelegations(
      ledger,
      authority,
      Effect.sync(() => now),
      {
        arm: () => Effect.succeed(2000),
        wake: () => Effect.die("Rejected acceptance must not wake"),
      }
    )
    expect(
      await run(
        app
          .run({ objective: "Draft", tasks: [f.task] }, f.source)
          .pipe(Effect.result)
      )
    ).toMatchObject({ _tag: "Failure", failure: { code: "unavailable" } })
    expect(allocated).toBeDefined()
    expect(
      await f.h.conversation(allocated as ConversationId, ctx)
    ).toBeUndefined()
    expect(await run(f.ledger.catalog())).toEqual([])
    expect(await run(f.ledger.parent(f.source.turnId))).toBeUndefined()
  } finally {
    await f.h.close(ctx)
  }
})

it("a lost acknowledgement recovers the original receipt and message identity rejects changed content", async () => {
  const f = await modelFixture()
  try {
    const saved = await f.seed(),
      child = saved.children[0]!.id,
      original = requestId(saved, child)
    const app = makeDelegations(f.ledger, authority, Effect.succeed(2000))
    await run(app.reconcile(saved.turnId))
    await run(f.ledger.waitRequest(child, original))
    const receipt = await run(f.ledger.submission(child, original))
    await run(
      f.ledger.atomic((tx) =>
        Effect.gen(function* () {
          const doc = yield* tx.group(7)
          doc.value = {
            ...doc.value!,
            dispatches: doc.value!.dispatches!.map((command) => ({
              ...command,
              receipt: undefined,
              state: "unconfirmed" as const,
            })),
          }
        })
      )
    )
    const fresh = makeDelegations(
      {
        ...f.ledger,
        submit: () => Effect.die("Recovery must use the original receipt"),
      },
      authority,
      Effect.succeed(2000)
    )
    await run(fresh.reconcile(saved.turnId))
    expect((await run(f.ledger.group(7))).dispatches).toMatchObject([
      { request: original, receipt, state: "confirmed" },
    ])
    expect((await run(f.ledger.group(7))).closed).toBe(false)
    await run(
      app.deliverMessage(child, "Attributed follow-up", "message-original")
    )
    await run(
      app.deliverMessage(child, "Attributed follow-up", "message-original")
    )
    expect(
      await run(
        app
          .deliverMessage(child, "Changed content", "message-original")
          .pipe(Effect.result)
      )
    ).toMatchObject({ _tag: "Failure", failure: { code: "conflict" } })
    expect(
      (await run(f.ledger.group(7))).dispatches!.filter(
        (command) => command.request === "message-original"
      )
    ).toHaveLength(1)
  } finally {
    await f.h.close(ctx)
  }
})
