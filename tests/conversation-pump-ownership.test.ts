import { it as effectIt } from "@effect/vitest"
import { Cause, Context, Deferred, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { expect, it } from "vitest"

import { conversationNativeOperation } from "../src/conversations/adapters/pi-execution"
import { ConversationExecutionError } from "../src/conversations/execution"
import {
  conversationPump,
  conversationControlPassMs,
} from "../src/conversations/pump"
import { ConversationStorageError } from "../src/conversations/turns"
import { conversationFixture } from "./conversation-fixture"

const pump = (f: Effect.Success<ReturnType<typeof conversationFixture>>) =>
  conversationPump(f.conversations, f.memory, f.journal, f.execution, f.host)
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

for (const operation of ["configure", "submit"] as const) {
  it(`keeps the native ${operation} owner occupied through Stop and joined cancellation`, async () => {
    const f = await Effect.runPromise(conversationFixture())
    await Effect.runPromise(
      f.store.admit({ operationId: "root", text: "hello" })
    )
    const entered = deferred(),
      release = deferred()
    let calls = 0
    f.execution[operation] = () =>
      conversationNativeOperation(operation, async () => {
        calls++
        entered.resolve()
        await release.promise
      })
    const core = pump(f)
    const controller = new AbortController()
    const pending = Effect.runPromiseExit(core.run(), {
      signal: controller.signal,
    })
    await entered.promise
    const owner = (await Effect.runPromise(f.store.get("root")))!.control!.owner
    expect(owner).not.toBeNull()
    await Effect.runPromise(f.store.requestStop("root"))
    controller.abort()
    await Effect.runPromise(core.reconcile())
    expect(await Effect.runPromise(core.run())).toBeUndefined()
    expect((await Effect.runPromise(f.store.get("root")))!.control!.owner).toBe(
      owner
    )
    expect(calls).toBe(1)
    release.resolve()
    const exit = await pending
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(await Effect.runPromise(f.store.get("root"))).toMatchObject({
      status: "stopping",
      control: { owner: null },
    })
    await Effect.runPromise(core.run())
    expect(f.events).toContain("abort")
    expect(await Effect.runPromise(f.store.get("root"))).toMatchObject({
      status: "cancelled",
      control: { owner: null },
    })
  })
}

it("retains a steer admitted while native observation is held and does not complete the old member set", async () => {
  const f = await Effect.runPromise(conversationFixture())
  await Effect.runPromise(f.store.admit({ operationId: "root", text: "hello" }))
  await Effect.runPromise(f.store.submitted("root", "session"))
  const entered = deferred(),
    release = deferred()
  const observe = f.execution.observe
  f.execution.observe = (root, members) =>
    observe(root, members).pipe(
      Effect.tap(() =>
        Effect.promise(async () => {
          entered.resolve()
          await release.promise
        })
      )
    )
  const pending = Effect.runPromise(pump(f).run())
  await entered.promise
  await Effect.runPromise(
    f.store.admit({ operationId: "steer", text: "use blue", mode: "steer" })
  )
  release.resolve()
  await pending
  expect(await Effect.runPromise(f.store.get("root"))).toMatchObject({
    status: "running",
    control: { owner: null },
  })
  expect(await Effect.runPromise(f.store.get("steer"))).toMatchObject({
    status: "queued",
  })
  expect(f.events).not.toContain("completed")
  f.execution.observe = observe
  await Effect.runPromise(pump(f).run())
  expect(f.events.filter((event) => event === "steer:steer")).toHaveLength(1)
  expect(await Effect.runPromise(f.store.get("steer"))).toMatchObject({
    status: "done",
  })
})

it("rechecks revoked authority after observation and commits Stop before finalizing the answer", async () => {
  const f = await Effect.runPromise(conversationFixture())
  await Effect.runPromise(f.store.admit({ operationId: "root", text: "hello" }))
  await Effect.runPromise(f.store.submitted("root", "session"))
  let authorized = true
  f.host.canRun = () => Effect.succeed(authorized)
  const observe = f.execution.observe
  f.execution.observe = (root, members) =>
    observe(root, members).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          authorized = false
        })
      )
    )
  await Effect.runPromise(pump(f).run())
  expect(f.events.indexOf("abort")).toBeGreaterThan(f.events.indexOf("observe"))
  expect(await Effect.runPromise(f.store.get("root"))).toMatchObject({
    status: "cancelled",
    control: { owner: null },
  })
})

it("reconciles a native handoff receipt before any repeated configure or submit", async () => {
  const f = await Effect.runPromise(conversationFixture())
  await Effect.runPromise(f.store.admit({ operationId: "root", text: "hello" }))
  await Effect.runPromise(f.store.prepare("root"))
  await Effect.runPromise(f.store.savePrompt("root", "pinned"))
  await Effect.runPromise(f.store.saveSession("root", "session"))
  const observe = f.execution.observe
  f.execution.observe = (root, members) =>
    observe(root, members).pipe(
      Effect.map((reply) => ({ ...reply, accepted: [root.id], settled: false }))
    )
  await Effect.runPromise(pump(f).run())
  expect(f.events).toEqual(["observe"])
  expect(await Effect.runPromise(f.store.get("root"))).toMatchObject({
    status: "running",
    prompt: "pinned",
    session_id: "session",
    control: { owner: null },
  })
})

it("inspect retains uncertain running ownership and only settles a correlated final reply", async () => {
  const f = await Effect.runPromise(conversationFixture())
  await Effect.runPromise(f.store.admit({ operationId: "root", text: "hello" }))
  await Effect.runPromise(f.store.submitted("root", "session"))
  await Effect.runPromise(
    f.store.claimControl("root", "failed-owner", Date.now() + 60_000)
  )
  await Effect.runPromise(
    f.store.releaseControl("root", "failed-owner", false, {
      failed: true,
      timedOut: true,
      phase: "observe",
      inspected: false,
      error: "Check the reply",
    })
  )
  const observe = f.execution.observe
  f.execution.observe = (root, members) =>
    observe(root, members).pipe(
      Effect.map((reply) => ({ ...reply, accepted: [root.id], settled: false }))
    )
  expect(await Effect.runPromise(pump(f).run())).toBeUndefined()
  expect(f.events).toEqual([])
  let root = (await Effect.runPromise(f.store.get("root")))!
  await Effect.runPromise(
    pump(f).run("inspect", { id: root.id, revision: root.revision })
  )
  expect(await Effect.runPromise(f.store.get("root"))).toMatchObject({
    status: "running",
    control: { owner: null, unconfirmed: "observe" },
  })
  expect(f.events).toEqual(["observe"])
  f.execution.observe = (root, members) =>
    observe(root, members).pipe(
      Effect.map((reply) => ({ ...reply, accepted: [root.id] }))
    )
  root = (await Effect.runPromise(f.store.get("root")))!
  await Effect.runPromise(
    pump(f).run("inspect", { id: root.id, revision: root.revision })
  )
  expect(await Effect.runPromise(f.store.get("root"))).toMatchObject({
    status: "done",
    control: { owner: null, unconfirmed: null },
  })
  expect(f.events).not.toContain("abort")
  expect(f.events).not.toContain("submit")
})

it("rejects a stale or different targeted inspection before native observation", async () => {
  const f = await Effect.runPromise(conversationFixture())
  const admitted = await Effect.runPromise(
    f.store.admit({ operationId: "root", text: "hello" })
  )
  const old = await Effect.runPromise(
    pump(f)
      .run("inspect", { id: "old-root", revision: admitted.turn.revision })
      .pipe(Effect.result)
  )
  expect(old).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ConversationConflict" },
  })
  await Effect.runPromise(f.store.requestStop("root"))
  const stale = await Effect.runPromise(
    pump(f)
      .run("inspect", { id: "root", revision: admitted.turn.revision })
      .pipe(Effect.result)
  )
  expect(stale).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ConversationConflict" },
  })
  expect(f.events).toEqual([])
})

effectIt.effect(
  "persists exhausted observation as unconfirmed while leaving Pi execution and approval time unbounded",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationFixture()
      yield* f.store.admit({ operationId: "root", text: "hello" })
      yield* f.store.submitted("root", "session")
      const entered = yield* Deferred.make<void>()
      f.execution.observe = () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
      const running = yield* pump(f).run().pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* TestClock.adjust(conversationControlPassMs)
      const exit = yield* Fiber.await(running)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* f.store.get("root")).toMatchObject({
        status: "running",
        control: { owner: null, unconfirmed: "observe" },
      })
      expect(f.events).not.toContain("abort")
      expect(yield* pump(f).run()).toBeUndefined()
    })
)

it("keeps compound native failures when releasing the joined owner also fails", async () => {
  const f = await Effect.runPromise(conversationFixture())
  await Effect.runPromise(f.store.admit({ operationId: "root", text: "hello" }))
  await Effect.runPromise(f.store.submitted("root", "session"))
  const entered = deferred(),
    release = deferred()
  const late = new Error("late native cleanup")
  const marker = Context.Service<string>("Test/ConversationCleanupMarker")
  f.execution.observe = () =>
    conversationNativeOperation("held observation", async () => {
      entered.resolve()
      await release.promise
      throw Cause.annotate(Cause.fail(late), Context.make(marker, "preserved"))
    })
  const releaseFailure = new ConversationStorageError({
    operation: "release control",
    cause: "offline",
  })
  f.store.releaseControl = () => Effect.fail(releaseFailure)
  const controller = new AbortController()
  const pending = Effect.runPromiseExit(pump(f).run(), {
    signal: controller.signal,
  })
  await entered.promise
  controller.abort()
  release.resolve()
  const exit = await pending
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) return
  expect(Cause.hasInterrupts(exit.cause)).toBe(true)
  expect(
    exit.cause.reasons.filter(
      (reason) => reason._tag === "Die" && reason.defect === releaseFailure
    )
  ).toHaveLength(1)
  const native = exit.cause.reasons.flatMap((reason) =>
    reason._tag === "Die" &&
    Cause.isReason(reason.defect) &&
    Cause.isFailReason(reason.defect)
      ? [reason.defect]
      : []
  )
  expect(
    native.filter(
      (reason) =>
        reason.error instanceof ConversationExecutionError &&
        reason.error.cause === late
    )
  ).toHaveLength(1)
  expect(native[0]?.annotations.get(marker.key)).toBe("preserved")
  expect(
    (await Effect.runPromise(f.store.get("root")))!.control!.owner
  ).not.toBeNull()
  expect(await Effect.runPromise(pump(f).run())).toBeUndefined()
})

it("repairs the completed owner on the same warm host without renewing its exhausted native budget", async () => {
  const f = await Effect.runPromise(conversationFixture())
  await Effect.runPromise(f.store.admit({ operationId: "root", text: "hello" }))
  const core = pump(f)
  let calls = 0
  f.execution.configure = () =>
    Effect.suspend(() => {
      calls++
      return Effect.fail(
        new ConversationExecutionError({
          operation: "configure",
          cause: "offline",
        })
      )
    })
  await Effect.runPromiseExit(core.run())
  await Effect.runPromiseExit(core.run())
  const originalRelease = f.store.releaseControl.bind(f.store)
  f.store.releaseControl = () =>
    Effect.fail(
      new ConversationStorageError({
        operation: "release control",
        cause: "offline",
      })
    )
  await Effect.runPromiseExit(core.run())
  expect(calls).toBe(3)
  expect(
    (await Effect.runPromise(f.store.get("root")))!.control!.owner
  ).not.toBeNull()
  f.store.releaseControl = originalRelease
  await Effect.runPromise(core.run())
  expect(calls).toBe(3)
  await Effect.runPromise(core.reconcile())
  await Effect.runPromise(core.run())
  expect(calls).toBe(3)
  expect(await Effect.runPromise(f.store.get("root"))).toMatchObject({
    status: "preparing",
    control: { owner: null, unconfirmed: "handoff" },
  })
})

effectIt.effect(
  "successful approval observations do not impose a total Pi execution lifetime",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationFixture()
      yield* f.store.admit({ operationId: "root", text: "hello" })
      yield* f.store.submitted("root", "session")
      f.host.awaitingAccess = () => Effect.succeed(true)
      const observe = f.execution.observe
      f.execution.observe = (root, members) =>
        observe(root, members).pipe(
          Effect.map((reply) => ({
            ...reply,
            accepted: [root.id],
            settled: false,
          }))
        )
      for (let pass = 0; pass < 5; pass++) {
        yield* pump(f).run()
        yield* TestClock.adjust(40_000)
      }
      expect(yield* f.store.get("root")).toMatchObject({
        status: "running",
        control: { owner: null, unconfirmed: null },
      })
      expect(f.events.filter((event) => event === "observe")).toHaveLength(5)
      expect(f.events).not.toContain("abort")
    })
)

it("atomically records the third failed native pass before releasing its owner", async () => {
  const f = await Effect.runPromise(conversationFixture())
  await Effect.runPromise(f.store.admit({ operationId: "root", text: "hello" }))
  let calls = 0
  f.execution.configure = () =>
    Effect.suspend(() => {
      calls++
      return Effect.fail(
        new ConversationExecutionError({
          operation: "configure",
          cause: "offline",
        })
      )
    })
  for (let attempt = 0; attempt < 3; attempt++)
    await Effect.runPromiseExit(pump(f).run())
  expect(await Effect.runPromise(f.store.get("root"))).toMatchObject({
    status: "preparing",
    control: { owner: null, attempts: 3, unconfirmed: "handoff" },
  })
  await Effect.runPromise(pump(f).run())
  expect(calls).toBe(3)
})

it("binds a session acquired after Stop so cleanup can address the exact native resource", async () => {
  const f = await Effect.runPromise(conversationFixture())
  await Effect.runPromise(f.store.admit({ operationId: "root", text: "hello" }))
  const entered = deferred(),
    release = deferred()
  f.execution.createSession = () =>
    conversationNativeOperation("create session", async () => {
      entered.resolve()
      await release.promise
      return "late-session"
    })
  const pending = Effect.runPromise(pump(f).run())
  await entered.promise
  await Effect.runPromise(f.store.requestStop("root"))
  release.resolve()
  await pending
  expect(await Effect.runPromise(f.store.get("root"))).toMatchObject({
    status: "stopping",
    session_id: "late-session",
    control: { owner: null },
  })
  expect(f.events).not.toContain("configure")
  expect(f.events).not.toContain("submit")
  const stopped: string[] = []
  f.execution.abort = (session) =>
    Effect.sync(() => {
      stopped.push(session)
    })
  await Effect.runPromise(pump(f).run())
  expect(stopped).toEqual(["late-session"])
  expect(await Effect.runPromise(f.store.get("root"))).toMatchObject({
    status: "cancelled",
  })
})

it("bounds runtime preparation errors inside the durable root attempt", async () => {
  const f = await Effect.runPromise(conversationFixture())
  await Effect.runPromise(f.store.admit({ operationId: "root", text: "hello" }))
  let calls = 0
  const core = conversationPump(
    f.conversations,
    f.memory,
    f.journal,
    f.execution,
    {
      ...f.host,
      prepareRuntime: () =>
        Effect.suspend(() => {
          calls++
          return Effect.fail(
            new ConversationExecutionError({
              operation: "prepare runtime",
              cause: "offline",
            })
          )
        }),
    }
  )
  for (let attempt = 0; attempt < 4; attempt++)
    await Effect.runPromiseExit(core.run())
  expect(calls).toBe(3)
  expect(await Effect.runPromise(f.store.get("root"))).toMatchObject({
    status: "queued",
    control: { owner: null, attempts: 3, unconfirmed: "handoff" },
  })
  expect(f.events).not.toContain("create")
})

it("skips runtime preparation for revoked cleanup and checks authority again after setup", async () => {
  for (const initiallyAllowed of [false, true]) {
    const f = await Effect.runPromise(conversationFixture())
    await Effect.runPromise(
      f.store.admit({ operationId: "root", text: "hello" })
    )
    let allowed = initiallyAllowed,
      calls = 0
    const core = conversationPump(
      f.conversations,
      f.memory,
      f.journal,
      f.execution,
      {
        ...f.host,
        canRun: () => Effect.succeed(allowed),
        prepareRuntime: () =>
          Effect.sync(() => {
            calls++
            allowed = false
          }),
      }
    )
    await Effect.runPromise(core.run())
    expect(calls).toBe(initiallyAllowed ? 1 : 0)
    expect(f.events).not.toContain("create")
    expect(f.events).not.toContain("submit")
    expect(await Effect.runPromise(f.store.get("root"))).toMatchObject({
      status: "cancelled",
      control: { owner: null },
    })
  }
})

it("never releases a newer owner when a completed release acknowledgement was lost", async () => {
  const f = await Effect.runPromise(conversationFixture())
  await Effect.runPromise(f.store.admit({ operationId: "root", text: "hello" }))
  await Effect.runPromise(f.store.submitted("root", "session"))
  const observe = f.execution.observe
  f.execution.observe = (root, members) =>
    observe(root, members).pipe(
      Effect.map((reply) => ({ ...reply, settled: false }))
    )
  const originalRelease = f.store.releaseControl.bind(f.store)
  f.store.releaseControl = (...args) =>
    originalRelease(...args).pipe(
      Effect.andThen(
        Effect.fail(
          new ConversationStorageError({
            operation: "release acknowledgement",
            cause: "lost",
          })
        )
      )
    )
  const core = pump(f)
  const exit = await Effect.runPromiseExit(core.run())
  expect(Exit.isFailure(exit)).toBe(true)
  const newer = await Effect.runPromise(
    f.store.claimControl("root", "new-owner", Date.now() + 60_000)
  )
  expect(newer?.control?.owner).toBe("new-owner")
  f.store.releaseControl = originalRelease
  await Effect.runPromise(core.reconcile())
  await Effect.runPromise(core.reconcile())
  expect((await Effect.runPromise(f.store.get("root")))!.control!.owner).toBe(
    "new-owner"
  )
  expect(f.events.filter((event) => event === "observe")).toHaveLength(1)
  await Effect.runPromise(originalRelease("root", "new-owner"))
})

effectIt.effect(
  "a fresh Stop survives the old third handoff timing out during joined cleanup",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationFixture()
      yield* f.store.admit({ operationId: "root", text: "hello" })
      const core = pump(f)
      const configureError = new ConversationExecutionError({
        operation: "configure",
        cause: "offline",
      })
      f.execution.configure = () => Effect.fail(configureError)
      yield* Effect.exit(core.run())
      yield* Effect.exit(core.run())
      expect((yield* f.store.get("root"))?.control?.attempts).toBe(2)
      const entered = yield* Deferred.make<void>()
      const cleaning = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      f.execution.configure = () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Deferred.succeed(cleaning, undefined).pipe(
              Effect.andThen(Deferred.await(release))
            )
          )
        )
      const receipts: { rootId: string; revision: number; phase: string }[] = []
      const running = yield* core
        .run("automatic", undefined, (receipt) => receipts.push(receipt))
        .pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const oldRevision = (yield* f.store.get("root"))!.revision
      yield* TestClock.adjust(conversationControlPassMs)
      yield* Deferred.await(cleaning)
      yield* f.store.requestStop("root")
      const stopped = (yield* f.store.get("root"))!
      expect(stopped.status).toBe("stopping")
      expect(stopped.control?.owner).not.toBeNull()
      expect(stopped.revision).toBeGreaterThan(oldRevision)
      yield* core.reconcile()
      expect(yield* core.run()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      expect(Exit.isFailure(yield* Fiber.await(running))).toBe(true)
      expect(yield* f.store.get("root")).toMatchObject({
        status: "stopping",
        control: { owner: null, attempts: 0, unconfirmed: null },
      })
      expect(receipts.at(-1)).toMatchObject({
        revision: oldRevision,
        phase: "handoff",
      })
      yield* f.store.requestStop("root")
      expect((yield* f.store.get("root"))!.revision).toBe(stopped.revision)
      yield* core.run()
      expect(f.events).toContain("abort")
      expect(f.events).not.toContain("submit")
      expect(yield* f.store.get("root")).toMatchObject({
        status: "cancelled",
        control: { owner: null },
      })
    })
)

effectIt.effect(
  "late session binding cannot assign the old timeout to a newer Stop revision",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationFixture()
      yield* f.store.admit({ operationId: "root", text: "hello" })
      const core = pump(f)
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      f.execution.createSession = () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as("late-session")
        )
      const receipts: { rootId: string; revision: number; phase: string }[] = []
      const running = yield* core
        .run("automatic", undefined, (receipt) => receipts.push(receipt))
        .pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const oldRevision = (yield* f.store.get("root"))!.revision
      yield* f.store.requestStop("root")
      const stopRevision = (yield* f.store.get("root"))!.revision
      yield* TestClock.adjust(conversationControlPassMs)
      yield* Deferred.succeed(release, undefined)
      expect(Exit.isFailure(yield* Fiber.await(running))).toBe(true)
      expect(yield* f.store.get("root")).toMatchObject({
        status: "stopping",
        session_id: "late-session",
        control: { owner: null, unconfirmed: null },
      })
      expect(receipts.at(-1)).toMatchObject({
        revision: oldRevision,
        phase: "handoff",
      })
      expect(
        receipts.some(
          (receipt) =>
            receipt.revision === stopRevision && receipt.phase !== "stop"
        )
      ).toBe(false)
      yield* core.run()
      expect(f.events).toContain("abort")
      expect(f.events).not.toContain("configure")
      expect(f.events).not.toContain("submit")
    })
)
