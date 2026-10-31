import { it as effectIt } from "@effect/vitest"
import { createEffectActor, waitFor } from "@xstate/effect"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { expect, it } from "vitest"

import { commandClientMachine } from "../src/terminal/client.machine"
import {
  completeCommand,
  type CommandClient,
} from "../src/terminal/command-client"
import type { CommandRun } from "../src/terminal/contracts"
import { TerminalRuntimeError } from "../src/terminal/runtime"

const input = { id: "original-command", command: "printf hello" }
const running: CommandRun = {
  ...input,
  kind: "command",
  status: "running",
  output: "",
  exitCode: null,
  error: null,
  createdAt: 1,
  finishedAt: null,
  savedAt: null,
}
const done: CommandRun = {
  ...running,
  status: "succeeded",
  output: "hello",
  exitCode: 0,
  finishedAt: 2,
  savedAt: 2,
}
const idle = {
  runs: [],
  savedAt: 2,
  busy: false,
  cleanupError: null,
  session: null,
}
function client(overrides: Partial<CommandClient> = {}): CommandClient {
  return {
    start: Effect.succeed(running),
    read: Effect.succeed(done),
    state: Effect.succeed(idle),
    cancel: Effect.succeed(null),
    ...overrides,
  }
}
function reasons(exit: Exit.Exit<unknown, unknown>) {
  return Exit.isFailure(exit) ? exit.cause.reasons : []
}

effectIt.effect(
  "deadline cancellation joins a held observation cleanup and preserves its late defect",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const cancelling = yield* Deferred.make<void>()
      const cleaning = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const defect = new Error("held observation cleanup")
      let cancels = 0
      const fiber = yield* Effect.forkChild(
        Effect.exit(
          completeCommand(
            input,
            client({
              start: Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  Deferred.succeed(cleaning, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(Effect.die(defect))
                  )
                )
              ),
              cancel: Effect.sync(() => {
                cancels++
                return null
              }).pipe(
                Effect.tap(() => Deferred.succeed(cancelling, undefined))
              ),
            })
          )
        )
      )
      yield* Deferred.await(entered)
      yield* TestClock.adjust("45 seconds")
      yield* Deferred.await(cancelling)
      yield* Deferred.await(cleaning)
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      const exit = yield* Fiber.join(fiber)
      expect(reasons(exit)).toContainEqual(
        expect.objectContaining({ _tag: "Die", defect })
      )
      expect(reasons(exit)).toContainEqual(
        expect.objectContaining({
          _tag: "Die",
          defect: expect.objectContaining({
            _tag: "TerminalFailure",
            message: expect.stringContaining("observation window"),
          }),
        })
      )
      expect(cancels).toBe(1)
    })
)

effectIt.effect(
  "Stop fences one identity before joining held cleanup and retains both cleanup failures",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const cancelled = yield* Deferred.make<void>()
      const cleaning = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const cleanupDefect = new Error("late receipt cleanup")
      const cancelFailure = new TerminalRuntimeError({
        operation: "cancel command",
        cause: "stop acknowledgement lost",
      })
      let cancels = 0
      const fiber = yield* Effect.forkChild(
        completeCommand(
          input,
          client({
            start: Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Deferred.succeed(cleaning, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(Effect.die(cleanupDefect))
                )
              )
            ),
            cancel: Effect.sync(() => {
              cancels++
            }).pipe(
              Effect.andThen(Deferred.succeed(cancelled, undefined)),
              Effect.andThen(Effect.fail(cancelFailure))
            ),
          })
        )
      )
      yield* Deferred.await(entered)
      const interrupted = yield* Effect.forkChild(Fiber.interrupt(fiber))
      yield* Deferred.await(cancelled)
      yield* Deferred.await(cleaning)
      expect(interrupted.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(interrupted)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(reasons(exit)).toContainEqual(
        expect.objectContaining({ _tag: "Die", defect: cleanupDefect })
      )
      expect(reasons(exit)).toContainEqual(
        expect.objectContaining({
          _tag: "Die",
          defect: expect.objectContaining({
            _tag: "Fail",
            error: cancelFailure,
          }),
        })
      )
      expect(cancels).toBe(1)
    })
)

for (const phase of ["start", "read", "state"] as const) {
  effectIt.effect(
    `retains a compound ${phase} failure without admitting another command`,
    () =>
      Effect.gen(function* () {
        const failure = new TerminalRuntimeError({
          operation: phase,
          cause: "expected",
        })
        const defect = new Error(`${phase} teardown`)
        let admissions = 0
        const entered = yield* Deferred.make<void>()
        const fail = Effect.fail(failure).pipe(
          Effect.ensuring(Effect.die(defect))
        )
        const work = client({
          start: Effect.sync(() => {
            admissions++
            return phase === "state" ? done : running
          }).pipe(
            Effect.tap(() => Deferred.succeed(entered, undefined)),
            Effect.flatMap((run) =>
              phase === "start" ? fail : Effect.succeed(run)
            )
          ),
          read: phase === "read" ? fail : Effect.succeed(done),
          state: phase === "state" ? fail : Effect.succeed(idle),
        })
        const fiber = yield* Effect.forkChild(
          Effect.exit(completeCommand(input, work))
        )
        yield* Deferred.await(entered)
        if (phase === "read") yield* TestClock.adjust("500 millis")
        const exit = yield* Fiber.join(fiber)
        expect(reasons(exit)).toContainEqual(
          expect.objectContaining({ _tag: "Die", defect })
        )
        expect(reasons(exit)).toContainEqual(
          expect.objectContaining({
            _tag: "Die",
            defect: failure,
          })
        )
        expect(admissions).toBe(1)
      })
  )
}

it("captures immutable input and validates every observed receipt against it", async () => {
  const original = { ...input }
  const machine = commandClientMachine(
    original,
    client({ start: Effect.succeed(done) })
  )
  original.command = "different"
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const actor = yield* createEffectActor(machine)
      const done = yield* waitFor(actor, (state) => state.status === "done")
      return yield* done.output!
    }).pipe(Effect.scoped)
  )
  expect(result.command).toBe(input.command)
})

effectIt.effect(
  "a conflicting polling receipt ends observation without a second admission",
  () =>
    Effect.gen(function* () {
      let admissions = 0,
        reads = 0,
        stateReads = 0
      const entered = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(
        Effect.exit(
          completeCommand(
            input,
            client({
              start: Effect.sync(() => {
                admissions++
                return running
              }).pipe(Effect.tap(() => Deferred.succeed(entered, undefined))),
              read: Effect.sync(() => {
                reads++
                return { ...done, id: "other-command" }
              }),
              state: Effect.sync(() => {
                stateReads++
                return idle
              }),
            })
          )
        )
      )
      yield* Deferred.await(entered)
      yield* TestClock.adjust("500 millis")
      expect(reasons(yield* Fiber.join(fiber))).toContainEqual(
        expect.objectContaining({
          _tag: "Fail",
          error: expect.objectContaining({
            _tag: "TerminalFailure",
            message: expect.stringContaining("different input"),
          }),
        })
      )
      expect({ admissions, reads, stateReads }).toEqual({
        admissions: 1,
        reads: 1,
        stateReads: 0,
      })
    })
)

effectIt.effect(
  "Stop during deadline cancellation joins the same held acknowledgement",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const cancelling = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const failure = new TerminalRuntimeError({
        operation: "cancel command",
        cause: "late Stop acknowledgement failed",
      })
      let cancels = 0
      const fiber = yield* Effect.forkChild(
        completeCommand(
          input,
          client({
            start: Deferred.succeed(entered, undefined).pipe(
              Effect.as(running)
            ),
            read: Effect.succeed(running),
            cancel: Effect.sync(() => {
              cancels++
            }).pipe(
              Effect.andThen(Deferred.succeed(cancelling, undefined)),
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(Effect.fail(failure))
            ),
          })
        )
      )
      yield* Deferred.await(entered)
      yield* TestClock.adjust("45 seconds")
      yield* Deferred.await(cancelling)
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))
      yield* Effect.yieldNow
      expect(interrupting.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(interrupting)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(reasons(exit)).toContainEqual(
        expect.objectContaining({
          _tag: "Die",
          defect: expect.objectContaining({ _tag: "Fail", error: failure }),
        })
      )
      expect(cancels).toBe(1)
    })
)
