import { expect, it } from "@effect/vitest"
import { Cause, Clock, Context, Effect, Exit } from "effect"
import { it as nativeIt } from "vitest"

import { ConversationExecutionError } from "../src/conversations/execution"
import { conversationPump } from "../src/conversations/pump"
import { conversationFixture } from "./conversation-fixture"

const pump = (f: Effect.Success<ReturnType<typeof conversationFixture>>) =>
  conversationPump(f.conversations, f.memory, f.journal, f.execution, f.host)
it.effect(
  "skips submission if another coordinator completes the turn during configuration",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationFixture()
      const root = Effect.runSync(
        f.store.admit({ operationId: "root", text: "hello" })
      ).turn
      f.execution.configure = () =>
        Effect.sync(() => {
          expect(
            Effect.runSync(
              f.store.finish(
                Effect.runSync(f.store.get(root.id))!,
                [{ id: root.id, delivery: "answered" }],
                "already done",
                null
              )
            )
          ).toBe(true)
        })
      yield* pump(f).run()
      expect(f.events).not.toContain("submit")
      expect(Effect.runSync(f.store.get(root.id))).toMatchObject({
        status: "done",
        answer: "already done",
      })
    })
)
it.effect(
  "pins prompt and session before submission and publishes completion after commit",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationFixture()
      const root = Effect.runSync(
        f.store.admit({ operationId: "root", text: "hello" })
      ).turn
      const now = yield* Clock.currentTimeMillis
      f.execution.submit = (_session, turn) =>
        Effect.sync(() => {
          const saved = Effect.runSync(f.store.get(turn.id))!
          expect(saved.session_id).toBe("session")
          expect(saved.prompt).toBe(turn.prompt)
          expect(saved.status).toBe("preparing")
          f.events.push("submit")
        })
      expect(yield* pump(f).run()).toBe(now + 100)
      expect(f.events).toEqual(["create", "configure", "compaction", "submit"])
      expect(Effect.runSync(f.store.get(root.id))?.status).toBe("running")
      expect(yield* pump(f).run()).toBe(now + 10)
      expect(f.events.slice(4)).toEqual([
        "delegate.reconcile",
        "observe",
        "completed",
        "background",
        "access.cancel",
        "compaction",
        "backup",
      ])
      expect(Effect.runSync(f.store.get(root.id))).toMatchObject({
        status: "done",
        answer: "Answer",
      })
    })
)
it.effect(
  "retries native submission with the same pinned session, prompt and operation identity",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationFixture()
      const root = Effect.runSync(
        f.store.admit({ operationId: "root", text: "hello" })
      ).turn
      const attempts: { id: string; session: string; prompt: string | null }[] =
        []
      f.execution.submit = (session, turn) =>
        Effect.sync(() => {
          attempts.push({ id: turn.id, session, prompt: turn.prompt })
        }).pipe(
          Effect.flatMap(() =>
            attempts.length === 1
              ? Effect.fail(
                  new ConversationExecutionError({
                    operation: "submit",
                    cause: "lost acknowledgment",
                  })
                )
              : Effect.void
          )
        )
      expect(yield* pump(f).run().pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConversationExecutionError" },
      })
      expect(Effect.runSync(f.store.get(root.id))?.status).toBe("preparing")
      // The new input temporarily makes Memory unsettled; finish its summary.
      yield* f.memory.saveNode({ start: 0, count: 1 }, "hello")
      yield* pump(f).run()
      expect(attempts).toHaveLength(2)
      expect(attempts[1]).toEqual(attempts[0])
      expect(f.events.filter((event) => event === "create")).toHaveLength(1)
      expect(yield* f.memory.total()).toBe(1)
    })
)
it.effect(
  "rejects submission if stop arrives during native configuration",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationFixture()
      const root = Effect.runSync(
        f.store.admit({ operationId: "root", text: "hello" })
      ).turn
      f.execution.configure = () =>
        Effect.sync(() => {
          Effect.runSync(f.store.requestStop(root.id))
          f.events.push("configure")
        })
      const now = yield* Clock.currentTimeMillis
      expect(yield* pump(f).run()).toBe(now + 10)
      expect(f.events).not.toContain("submit")
      expect(Effect.runSync(f.store.get(root.id))?.status).toBe("stopping")
    })
)
it.effect(
  "rechecks authority before native submission after a wake yields",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationFixture()
      const root = Effect.runSync(
        f.store.admit({ operationId: "root", text: "hello" })
      ).turn
      let allowed = true
      f.host.canRun = () => Effect.sync(() => allowed)
      f.host.wakeCompaction = () =>
        Effect.sync(() => {
          allowed = false
        })
      yield* pump(f).run()
      expect(f.events).not.toContain("submit")
      expect(Effect.runSync(f.store.get(root.id))?.status).toBe("stopping")
    })
)
it.effect(
  "keeps a newer completion receipt pending and uses the caller Clock for approval retry",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationFixture()
      Effect.runSync(f.store.admit({ operationId: "root", text: "hello" }))
      Effect.runSync(f.store.submitted("root", "session"))
      f.host.awaitingAccess = () => Effect.succeed(true)
      const observe = f.execution.observe
      f.execution.observe = (root, members) =>
        observe(root, members).pipe(
          Effect.map((reply) => ({ ...reply, settled: false }))
        )
      const now = yield* Clock.currentTimeMillis
      expect(yield* pump(f).run()).toBe(now + 30_000)
      expect(Effect.runSync(f.store.get("root"))?.status).toBe("running")
      expect(f.events).not.toContain("completed")
    })
)
it.effect(
  "retains a late steer and refuses stale completion without unanswered notes",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationFixture()
      Effect.runSync(f.store.admit({ operationId: "root", text: "hello" }))
      Effect.runSync(f.store.submitted("root", "session"))
      const observe = f.execution.observe
      f.execution.observe = (root, members) =>
        observe(root, members).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              Effect.runSync(
                f.store.admit({
                  operationId: "steer",
                  text: "use blue",
                  mode: "steer",
                })
              )
            })
          )
        )
      const now = yield* Clock.currentTimeMillis
      expect(yield* pump(f).run()).toBe(now + 10)
      expect(Effect.runSync(f.store.get("root"))?.status).toBe("running")
      expect(Effect.runSync(f.store.get("steer"))?.status).toBe("queued")
      expect(yield* f.memory.total()).toBe(0)
      expect(f.events).not.toContain("completed")
    })
)
it.effect(
  "stops access and native execution before settling, retaining answered child results",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationFixture()
      Effect.runSync(f.store.admit({ operationId: "root", text: "hello" }))
      Effect.runSync(f.store.submitted("root", "session"))
      Effect.runSync(
        f.store.admit({ operationId: "steer", text: "use blue", mode: "steer" })
      )
      Effect.runSync(f.store.requestStop("root"))
      yield* pump(f).run()
      expect(f.events.slice(0, 3)).toEqual([
        "access.cancel",
        "abort",
        "plan.cancel",
      ])
      expect(f.events.some((event) => event.startsWith("steer:"))).toBe(false)
      expect(Effect.runSync(f.store.get("root"))?.status).toBe("cancelled")
      expect(Effect.runSync(f.store.get("steer"))?.status).toBe("done")
    })
)
it.effect(
  "fails blocked Memory atomically and wakes background work only after completion",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationFixture()
      const root = Effect.runSync(
        f.store.admit({ operationId: "root", text: "hello" })
      ).turn
      f.memory.settled = () => Effect.succeed(false)
      f.memory.blocked = () => Effect.succeed(true)
      f.host.wakeBackground = () =>
        Effect.sync(() => {
          expect(Effect.runSync(f.store.get(root.id))?.status).toBe("failed")
          f.events.push("background")
        })
      yield* pump(f).run()
      expect(f.events).toEqual(["background", "notify"])
      expect(Effect.runSync(f.store.get(root.id))?.error).toContain(
        "Memory summaries are paused"
      )
    })
)
class Caller extends Context.Service<Caller, { instructions: string }>()(
  "Test/ConversationCaller"
) {}
it.effect(
  "preserves caller requirements and typed host failures without premature writes",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationFixture()
      const root = Effect.runSync(
        f.store.admit({ operationId: "root", text: "hello" })
      ).turn
      const core = conversationPump<string, Caller>(
        f.conversations,
        f.memory,
        f.journal,
        f.execution,
        {
          ...f.host,
          instructions: () =>
            Caller.pipe(
              Effect.flatMap(({ instructions }) =>
                instructions
                  ? Effect.succeed(instructions)
                  : Effect.fail("missing instructions")
              )
            ),
        }
      )
      expect(
        yield* core
          .run()
          .pipe(
            Effect.provideService(Caller, { instructions: "" }),
            Effect.result
          )
      ).toMatchObject({ _tag: "Failure", failure: "missing instructions" })
      expect(yield* f.memory.total()).toBe(0)
      expect(Effect.runSync(f.store.get(root.id))?.prompt).toBeNull()
      yield* core
        .run()
        .pipe(
          Effect.provideService(Caller, { instructions: "caller instructions" })
        )
      expect(Effect.runSync(f.store.get(root.id))?.prompt).toContain(
        "caller instructions"
      )
    })
)

nativeIt(
  "binds a late native session before interruption ends, then skips configure and submit",
  async () => {
    const f = await Effect.runPromise(conversationFixture())
    const root = Effect.runSync(
      f.store.admit({ operationId: "root", text: "hello" })
    ).turn
    let started!: () => void, release!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const settled = new Promise<void>((resolve) => {
      release = resolve
    })
    f.execution.createSession = () =>
      Effect.promise(async () => {
        started()
        await settled
        return "late-session"
      })
    const controller = new AbortController()
    let ended = false
    const pending = Effect.runPromiseExit(pump(f).run(), {
      signal: controller.signal,
    }).then((exit) => {
      ended = true
      return exit
    })
    await entered
    controller.abort()
    expect(ended).toBe(false)
    release()
    const exit = await pending
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(Effect.runSync(f.store.get(root.id))?.session_id).toBe(
      "late-session"
    )
    expect(Effect.runSync(f.store.get(root.id))?.status).toBe("preparing")
    expect(f.events).not.toContain("configure")
    expect(f.events).not.toContain("submit")
  }
)

nativeIt(
  "uses the committed session when concurrent native acquisitions race",
  async () => {
    const f = await Effect.runPromise(conversationFixture())
    const root = Effect.runSync(
      f.store.admit({ operationId: "root", text: "hello" })
    ).turn
    let started!: () => void, release!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const settled = new Promise<void>((resolve) => {
      release = resolve
    })
    let acquisitions = 0
    const configured: string[] = []
    f.memory.settled = () => Effect.succeed(true)
    f.execution.createSession = () =>
      Effect.promise(async () => {
        if (++acquisitions === 1) {
          started()
          await settled
          return "late-session"
        }
        return "committed-session"
      })
    f.execution.configure = (session) =>
      Effect.sync(() => {
        configured.push(session)
      })
    const first = Effect.runPromise(pump(f).run())
    await entered
    await Effect.runPromise(pump(f).run())
    release()
    await first
    expect(Effect.runSync(f.store.get(root.id))?.session_id).toBe(
      "committed-session"
    )
    expect(configured).toEqual(["committed-session", "committed-session"])
    expect(await Effect.runPromise(f.memory.total())).toBe(1)
  }
)
