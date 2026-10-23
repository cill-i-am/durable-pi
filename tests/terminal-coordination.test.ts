import { expect, it } from "@effect/vitest"
import { Clock, Deferred, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"

import { TerminalStore } from "../src/terminal/adapters/sqlite"
import type { TerminalRuntime } from "../src/terminal/runtime"
import { TerminalService, terminalLayer } from "../src/terminal/terminal"
import { database } from "./database"

it.effect(
  "uses the actor's Effect clock for expiry even when a request supplies another clock",
  () =>
    Effect.gen(function* () {
      const actorClock = yield* Clock.Clock
      let requestSleeps = 0
      const requestClock: Clock.Clock = {
        currentTimeMillisUnsafe: () => actorClock.currentTimeMillisUnsafe(),
        currentTimeMillis: actorClock.currentTimeMillis,
        currentTimeNanosUnsafe: () => actorClock.currentTimeNanosUnsafe(),
        currentTimeNanos: actorClock.currentTimeNanos,
        monotonicTimeNanosUnsafe: () => actorClock.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: actorClock.monotonicTimeNanos,
        sleep: (duration) => {
          requestSleeps++
          return actorClock.sleep(duration)
        },
      }
      const repository = new TerminalStore(database())
      Effect.runSync(repository.configure(0, true))
      const executing = yield* Deferred.make<void>()
      let snapshots = 0
      let closes = 0
      const runtime: TerminalRuntime = {
        restore: () => Effect.void,
        execute: () =>
          Deferred.succeed(executing, undefined).pipe(
            Effect.andThen(Effect.never)
          ),
        snapshot: () =>
          Effect.sync(() => {
            snapshots++
            return new Uint8Array([1])
          }),
        importFile: () => Effect.void,
        exportFile: () => Effect.succeed(new Uint8Array([1])),
        openInteractive: () => Effect.die("Unexpected interactive shell"),
        close: () =>
          Effect.sync(() => {
            closes++
          }),
        settle: () => Effect.void,
      }
      const storage = {
        read: () => Effect.succeed(new Uint8Array([1])),
        write: () =>
          Effect.die("An expired command cannot publish a checkpoint"),
        settle: () => Effect.void,
      }
      const services = yield* Layer.build(
        terminalLayer({
          repository,
          runtime,
          backups: storage,
          relay: () => {
            throw new Error("Unexpected socket")
          },
          digest: () => Effect.succeed("digest"),
        })
      )
      const terminal = yield* TerminalService.pipe(
        Effect.provideContext(services)
      )
      const task = yield* terminal
        .start({ id: "deadline", command: "wait" })
        .pipe(Effect.provideService(Clock.Clock, requestClock))
      yield* Deferred.await(executing)
      yield* TestClock.adjust("30 seconds")
      yield* task.completion
      expect(Effect.runSync(repository.get("deadline"))?.status).toBe("failed")
      expect(Effect.runSync(repository.checkpoint())).toBeNull()
      expect(snapshots).toBe(0)
      expect(closes).toBe(3)
      expect(requestSleeps).toBe(0)
      expect((yield* terminal.state()).busy).toBe(false)
    }).pipe(Effect.scoped)
)

it.effect(
  "joins every independent cleanup and retains their defects before releasing occupancy",
  () =>
    Effect.gen(function* () {
      const repository = new TerminalStore(database())
      yield* repository.configure(0, true)
      const calls: string[] = []
      const runtimeDefect = new Error("runtime settlement defect")
      const backupDefect = new Error("backup settlement defect")
      const mark = (name: string) =>
        Effect.sync(() => {
          calls.push(name)
        })
      const runtime: TerminalRuntime = {
        restore: () => Effect.void,
        execute: () => Effect.succeed(0),
        snapshot: () => Effect.succeed(new Uint8Array([1])),
        importFile: () => Effect.void,
        exportFile: () => Effect.succeed(new Uint8Array([1])),
        openInteractive: () => Effect.die("Unexpected shell"),
        close: () => mark("close"),
        settle: () =>
          mark("runtime").pipe(Effect.andThen(Effect.die(runtimeDefect))),
      }
      const backup = { key: "saved", sha256: "digest", size: 1, savedAt: 1 }
      const services = yield* Layer.build(
        terminalLayer({
          repository,
          runtime,
          backups: {
            read: () => Effect.succeed(new Uint8Array([1])),
            write: () => Effect.succeed(backup),
            settle: () =>
              mark("backups").pipe(Effect.andThen(Effect.die(backupDefect))),
          },
          exports: {
            read: () => Effect.succeed(new Uint8Array([1])),
            write: () => Effect.succeed(backup),
            settle: () => mark("exports"),
          },
          relay: () => {
            throw new Error("Unexpected socket")
          },
          digest: () => Effect.succeed("digest"),
        })
      )
      const terminal = yield* TerminalService.pipe(
        Effect.provideContext(services)
      )
      const task = yield* terminal.start({
        id: "cleanup-defects",
        command: "true",
      })
      const exit = yield* Effect.exit(task.completion)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const defects = exit.cause.reasons.flatMap((reason) =>
          reason._tag === "Die" ? [reason.defect] : []
        )
        expect(defects).toContain(runtimeDefect)
        expect(defects).toContain(backupDefect)
      }
      expect(calls).toEqual(["close", "runtime", "backups", "exports", "close"])
      expect(yield* repository.get("cleanup-defects")).toMatchObject({
        status: "succeeded",
        occupancy: { state: "blocked" },
      })
      expect((yield* terminal.state()).cleanupError).toContain(
        "cleanup could not be confirmed"
      )
    }).pipe(Effect.scoped)
)
