import { it } from "@effect/vitest"
import { createEffectActor, send, waitFor } from "@xstate/effect"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"

import { makeExportSaveOwner } from "../src/features/terminal/export-save"
import {
  LEASE_EXPIRED,
  sessionLeaseMachine,
} from "../src/features/terminal/session-lease.machine"
import { terminalSocketMachine } from "../src/features/terminal/socket.machine"
import {
  makeTerminalOwner,
  terminalCommand,
} from "../src/features/terminal/terminal-owner"
import type { TerminalRequest } from "../src/features/terminal/terminal-ui.machine"
import { nativeOperation } from "../src/shared/interop"
import type { CommandRun } from "../src/terminal/contracts"

const history = {
  runs: [],
  savedAt: null,
  busy: false,
  cleanupError: null,
  session: null,
}
const run = (id: string): CommandRun => ({
  id,
  command: "echo test",
  status: "running",
  output: "",
  error: null,
  exitCode: null,
  createdAt: 1,
  finishedAt: null,
  savedAt: null,
})
it.effect(
  "lease expiry wins over a held late renew and scope close joins its cleanup",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>(),
        cleanup = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>(),
        scope = yield* Scope.make()
      const actor = yield* createEffectActor(
        sessionLeaseMachine(
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Deferred.succeed(cleanup, undefined).pipe(
                Effect.andThen(Deferred.await(release))
              )
            )
          ),
          () => undefined
        ),
        { input: { expiresAt: 1000 } }
      ).pipe(Scope.provide(scope))
      yield* Deferred.await(started)
      yield* TestClock.adjust("1 second")
      yield* waitFor(actor, (value) => value.status === "done")
      expect(actor.getSnapshot().context).toMatchObject({
        ended: true,
        error: LEASE_EXPIRED,
      })
      const closing = yield* Scope.close(scope, Exit.void).pipe(
        Effect.forkChild
      )
      yield* Deferred.await(cleanup)
      expect(closing.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(closing)
    })
)
it.effect(
  "lease retry never extends the original expiry without a successful renew",
  () =>
    Effect.gen(function* () {
      let calls = 0
      const actor = yield* createEffectActor(
        sessionLeaseMachine(
          Effect.suspend(() => {
            calls++
            return Effect.fail(new Error("offline"))
          }),
          () => undefined
        ),
        { input: { expiresAt: 3000 } }
      )
      yield* waitFor(actor, (value) => value.context.delay === 2000)
      yield* TestClock.adjust("2 seconds")
      yield* waitFor(actor, () => calls === 2)
      yield* TestClock.adjust("1 second")
      yield* waitFor(actor, (value) => value.status === "done")
      expect(calls).toBe(2)
      expect(actor.getSnapshot().context.expiresAt).toBe(3000)
    }).pipe(Effect.scoped)
)
it.effect("authorization rejection ends lease without transport retry", () =>
  Effect.gen(function* () {
    const actor = yield* createEffectActor(
      sessionLeaseMachine(Effect.fail("forbidden"), () => "Session ended"),
      { input: { expiresAt: 30000 } }
    )
    yield* waitFor(actor, (value) => value.status === "done")
    expect(actor.getSnapshot().context.error).toBe("Session ended")
  }).pipe(Effect.scoped)
)
it.effect(
  "socket reconnect fences old ready/output and keeps queued bytes until current readiness",
  () =>
    Effect.gen(function* () {
      const closed = yield* Deferred.make<void>()
      let opens = 0
      const actor = yield* createEffectActor(
        terminalSocketMachine({
          open: () => {
            opens++
            return opens === 1 ? Deferred.await(closed) : Effect.never
          },
          close: () => Effect.void,
        })
      )
      const sent: number[] = [],
        output: number[] = []
      const flushed = yield* Deferred.make<void>()
      actor.on("send", (event) => {
        sent.push(event.bytes[0]!)
        Effect.runSync(Deferred.succeed(flushed, undefined))
      })
      actor.on("output", (event) => output.push(event.bytes[0]!))
      yield* send(actor, { type: "CONNECT" })
      yield* waitFor(actor, (value) => value.context.token === 1)
      yield* send(actor, { type: "INPUT", bytes: new Uint8Array([7]) })
      yield* waitFor(actor, (value) => value.context.bytes === 1)
      yield* Deferred.succeed(closed, undefined)
      yield* waitFor(actor, (value) => value.matches("retry"))
      yield* TestClock.adjust("1 second")
      yield* waitFor(actor, (value) => value.context.token === 2)
      yield* send(actor, { type: "READY", token: 1 })
      yield* send(actor, {
        type: "OUTPUT",
        token: 1,
        bytes: new Uint8Array([9]),
      })
      expect(sent).toEqual([])
      expect(output).toEqual([])
      yield* send(actor, { type: "READY", token: 2 })
      yield* waitFor(actor, (value) => value.matches({ open: "ready" }))
      yield* Deferred.await(flushed)
      expect(sent).toEqual([7])
      expect(opens).toBe(2)
    }).pipe(Effect.scoped)
)
it.effect(
  "socket disconnect joins close before another connect can acquire",
  () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const firstOpen = yield* Deferred.make<void>()
      const secondOpen = yield* Deferred.make<void>()
      let opens = 0
      const actor = yield* createEffectActor(
        terminalSocketMachine({
          open: () => {
            opens++
            return Deferred.succeed(
              opens === 1 ? firstOpen : secondOpen,
              undefined
            ).pipe(Effect.andThen(Effect.never))
          },
          close: () => Deferred.await(release),
        })
      )
      yield* send(actor, { type: "CONNECT" })
      yield* Deferred.await(firstOpen)
      yield* send(actor, { type: "DISCONNECT" })
      yield* waitFor(actor, (value) => value.matches("closing"))
      yield* send(actor, { type: "CONNECT" })
      expect(opens).toBe(1)
      yield* Deferred.succeed(release, undefined)
      yield* waitFor(actor, (value) => value.matches("idle"))
      yield* send(actor, { type: "CONNECT" })
      yield* Deferred.await(secondOpen)
    }).pipe(Effect.scoped)
)
it.effect(
  "uncertain transfer retry retains original payload and concurrent requests do not dispatch",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      const requests: TerminalRequest[] = []
      const actor = yield* makeTerminalOwner(
        { agentId: "one", selected: null, visible: false },
        {
          read: () => Effect.succeed({ history, run: null }),
          command: (request) =>
            Effect.gen(function* () {
              requests.push(request)
              if (requests.length === 1) {
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
                return yield* Effect.fail(new Error("unconfirmed"))
              }
              return { history: null, run: run("original") }
            }),
        }
      )
      const first = yield* terminalCommand(actor, {
        type: "start",
        attempt: {
          kind: "export",
          input: { id: "original", path: "/workspace/first.txt" },
        },
      }).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      expect(
        yield* terminalCommand(actor, {
          type: "start",
          attempt: {
            kind: "export",
            input: { id: "other", path: "/workspace/other.txt" },
          },
        })
      ).toBe(false)
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(first)).toBe(false)
      expect(actor.getSnapshot().context.pending?.input.id).toBe("original")
      expect(
        yield* terminalCommand(actor, {
          type: "start",
          attempt: {
            kind: "export",
            input: { id: "new", path: "/workspace/new.txt" },
          },
        })
      ).toBe(true)
      expect(requests.map((request) => request.body)).toEqual([
        { id: "original", path: "/workspace/first.txt" },
        { id: "original", path: "/workspace/first.txt" },
      ])
    }).pipe(Effect.scoped)
)
it.effect(
  "stopped terminal request joins native cleanup and never selects its late result",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>(),
        aborted = yield* Deferred.make<void>(),
        scope = yield* Scope.make()
      let release!: () => void
      const selected: string[] = []
      const actor = yield* makeTerminalOwner(
        { agentId: "old", selected: null, visible: false },
        {
          read: () => Effect.succeed({ history, run: null }),
          command: () =>
            nativeOperation(
              (signal) =>
                new Promise((resolve) => {
                  signal.addEventListener("abort", () =>
                    Effect.runSync(Deferred.succeed(aborted, undefined))
                  )
                  release = () => resolve({ history: null, run: run("late") })
                  Effect.runSync(Deferred.succeed(started, undefined))
                }),
              (cause) => cause
            ),
        }
      ).pipe(Scope.provide(scope))
      actor.on("selected", (event) => selected.push(event.id))
      const request = yield* terminalCommand(actor, {
        type: "start",
        attempt: { kind: "session", input: { id: "late" } },
      }).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const closing = yield* Scope.close(scope, Exit.void).pipe(
        Effect.forkChild
      )
      yield* Deferred.await(aborted)
      expect(closing.pollUnsafe()).toBeUndefined()
      release()
      yield* Fiber.join(closing)
      expect(yield* Fiber.join(request)).toBe(false)
      expect(selected).toEqual([])
    })
)
it.effect(
  "unmount during export download prevents upload and joins the download",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        aborted = yield* Deferred.make<void>(),
        scope = yield* Scope.make()
      let release!: () => void,
        uploads = 0
      const download = nativeOperation(
        (signal) =>
          new Promise<File>((resolve) => {
            signal.addEventListener("abort", () =>
              Effect.runSync(Deferred.succeed(aborted, undefined))
            )
            release = () => resolve(new File(["text"], "result.txt"))
            Effect.runSync(Deferred.succeed(entered, undefined))
          }),
        (cause) => cause
      )
      const actor = yield* makeExportSaveOwner({
        download,
        upload: () =>
          Effect.sync(() => {
            uploads++
          }),
      }).pipe(Scope.provide(scope))
      yield* send(actor, { type: "SAVE" })
      yield* Deferred.await(entered)
      const close = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild)
      yield* Deferred.await(aborted)
      expect(close.pollUnsafe()).toBeUndefined()
      release()
      yield* Fiber.join(close)
      expect(uploads).toBe(0)
    })
)
it.effect(
  "unmount during export upload joins actual settlement and retains cleanup defects",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        aborted = yield* Deferred.make<void>(),
        scope = yield* Scope.make()
      let reject!: (cause: unknown) => void
      const defect = new Error("late upload cleanup defect")
      const actor = yield* makeExportSaveOwner({
        download: Effect.succeed(new File(["text"], "result.txt")),
        upload: () =>
          nativeOperation(
            (signal) =>
              new Promise((_, fail) => {
                reject = fail
                signal.addEventListener("abort", () =>
                  Effect.runSync(Deferred.succeed(aborted, undefined))
                )
                Effect.runSync(Deferred.succeed(entered, undefined))
              }),
            (cause) => cause
          ),
      }).pipe(Scope.provide(scope))
      yield* send(actor, { type: "SAVE" })
      yield* Deferred.await(entered)
      const closing = yield* Effect.exit(Scope.close(scope, Exit.void)).pipe(
        Effect.forkChild
      )
      yield* Deferred.await(aborted)
      expect(closing.pollUnsafe()).toBeUndefined()
      const compound = Cause.fromReasons([
        ...Cause.fail("late typed upload failure").reasons,
        ...Cause.die(defect).reasons,
        ...Cause.interrupt(78123).reasons.map((reason) =>
          reason.annotate(
            Context.makeUnsafe(new Map([["f04-cleanup", "retained"]]))
          )
        ),
      ])
      reject(compound)
      const result = yield* Fiber.join(closing)
      expect(result._tag).toBe("Failure")
      if (Exit.isFailure(result)) {
        expect(result.cause.reasons).toContainEqual(
          expect.objectContaining({ _tag: "Die", defect })
        )
        const interruption = result.cause.reasons.find(
          (reason) => reason._tag === "Interrupt" && reason.fiberId === 78123
        )
        expect(interruption?.annotations.get("f04-cleanup")).toBe("retained")
        expect(result.cause.reasons).toContainEqual(
          expect.objectContaining({
            _tag: "Die",
            defect: expect.objectContaining({
              _tag: "Fail",
              error: "late typed upload failure",
            }),
          })
        )
      }
    })
)

it.effect("an already expired lease never dispatches renewal", () =>
  Effect.gen(function* () {
    let calls = 0
    const actor = yield* createEffectActor(
      sessionLeaseMachine(
        Effect.sync(() => {
          calls++
          return { expiresAt: 30000 }
        }),
        () => undefined
      ),
      { input: { expiresAt: 0 } }
    )
    yield* waitFor(actor, (value) => value.status === "done")
    expect(calls).toBe(0)
  }).pipe(Effect.scoped)
)
it.effect(
  "a completed mutation cannot reselect a view changed while its request was held",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>(),
        selected: string[] = []
      const actor = yield* makeTerminalOwner(
        { agentId: "one", selected: "old", visible: false },
        {
          read: () => Effect.succeed({ history, run: null }),
          command: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({ history: null, run: run("submitted") })
            ),
        }
      )
      actor.on("selected", (event) => selected.push(event.id))
      const request = yield* terminalCommand(actor, {
        type: "start",
        attempt: {
          kind: "command",
          input: { id: "submitted", command: "echo test" },
        },
      }).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* send(actor, { type: "SELECT", selected: "other" })
      yield* waitFor(actor, (value) => value.context.selected === "other")
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(request)).toBe(true)
      expect(actor.getSnapshot().context.selected).toBe("other")
      expect(selected).toEqual([])
    }).pipe(Effect.scoped)
)

it.effect(
  "an A to B to A navigation cycle rejects the old mutation selection",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>(),
        selected: string[] = []
      const actor = yield* makeTerminalOwner(
        { agentId: "one", selected: "A", visible: false },
        {
          read: () => Effect.succeed({ history, run: null }),
          command: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({ history: null, run: run("submitted") })
            ),
        }
      )
      actor.on("selected", (event) => selected.push(event.id))
      const request = yield* terminalCommand(actor, {
        type: "start",
        attempt: {
          kind: "command",
          input: { id: "submitted", command: "echo test" },
        },
      }).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* send(actor, { type: "SELECT", selected: "B" })
      yield* waitFor(actor, (value) => value.context.selected === "B")
      yield* send(actor, { type: "SELECT", selected: "A" })
      yield* waitFor(actor, (value) => value.context.selected === "A")
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(request)).toBe(true)
      expect(actor.getSnapshot().context.selected).toBe("A")
      expect(selected).toEqual([])
    }).pipe(Effect.scoped)
)
