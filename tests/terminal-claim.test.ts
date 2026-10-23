import { Cause, Effect, Exit, Scheduler, Schema } from "effect"
import { describe, expect, it, vi } from "vitest"

import { relayTerminal } from "../src/terminal/adapters/socket"
import { TerminalStore } from "../src/terminal/adapters/sqlite"
import {
  advanceCommandRecord,
  restoreCommandRecord,
} from "../src/terminal/command.machine"
import { CommandRun, TerminalState } from "../src/terminal/contracts"
import { database } from "./database"
import { Terminal, type TerminalRuntime } from "./terminal-fixture"

function barrier<A = void>() {
  let resolve!: (value: A) => void
  const promise = new Promise<A>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const input = { id: "first", command: "echo once" }
const checkpoint = {
  key: "checkpoint",
  sha256: "original",
  size: 1,
  savedAt: 42,
}
function fixture(overrides: Partial<TerminalRuntime> = {}) {
  const db = database(),
    store = new TerminalStore(db)
  const entered = barrier(),
    finish = barrier<number>()
  const runtime: TerminalRuntime = {
    close: vi.fn(async () => {}),
    restore: vi.fn(async () => {}),
    execute: vi.fn(async () => {
      entered.resolve()
      return finish.promise
    }),
    snapshot: vi.fn(async () => new Uint8Array([1])),
    ...overrides,
  }
  const terminal = new Terminal(
    store,
    runtime,
    { read: async () => new Uint8Array([1]), write: async () => checkpoint },
    relayTerminal
  )
  terminal.configure(1, true)
  return { db, store, terminal, runtime, entered, finish }
}
const run = <A, E>(effect: Effect.Effect<A, E>, budget = 128) =>
  Effect.runPromise(
    effect.pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, budget))
  )

it("projects public receipts while retaining private command ownership", async () => {
  const f = fixture()
  const task = await run(f.terminal.start(input))
  await f.entered.promise
  const replay = await run(f.terminal.start(input))
  const read = await run(f.terminal.service.get(input.id))
  expect(task.run).toEqual(Schema.decodeUnknownSync(CommandRun)(task.run))
  expect(replay.run).toEqual(task.run)
  expect(read).toEqual(task.run)
  const state = await run(f.terminal.service.state())
  expect(state).toEqual(Schema.decodeUnknownSync(TerminalState)(state))
  expect(Effect.runSync(f.store.get(input.id))).toMatchObject({
    schemaVersion: 1,
    workflowVersion: 1,
    revision: expect.any(Number),
    attemptId: expect.any(String),
    occupancy: { state: "held", ownerId: expect.any(String) },
  })
  const cancelled = await run(f.terminal.cancel(input.id))
  expect(cancelled).toEqual(Schema.decodeUnknownSync(CommandRun)(cancelled))
  expect(cancelled?.status).toBe("cancelled")
  f.finish.resolve(0)
  await Promise.all([task.completion, replay.completion])
  expect(await run(f.terminal.service.get(input.id))).toEqual(cancelled)
  expect(Effect.runSync(f.store.get(input.id))?.occupancy).toEqual({
    state: "free",
    ownerId: null,
  })
  expect(await run(f.terminal.service.get("missing"))).toBeUndefined()
  expect(await run(f.terminal.cancel("missing"))).toBeNull()
})

describe.each([128, 32])(
  "Terminal atomic claimant at scheduler budget %i",
  (budget) => {
    it.each([false, true])(
      "dispatches one duplicate behind a real SQLite transaction (held=%s)",
      async (held) => {
        const f = fixture(),
          lock = barrier(),
          release = barrier()
        const holding = held
          ? run(
              f.db.transaction(() =>
                Effect.sync(() => lock.resolve()).pipe(
                  Effect.andThen(Effect.promise(() => release.promise))
                )
              ),
              budget
            )
          : Promise.resolve()
        if (held) await lock.promise
        const first = run(f.terminal.start(input), budget),
          second = run(f.terminal.start(input), budget)
        release.resolve()
        await holding
        const [a, b] = await Promise.all([first, second])
        await f.entered.promise
        expect(f.runtime.execute).toHaveBeenCalledTimes(1)
        expect(
          f.db.all<{ n: number }>("select count(*) as n from terminal_runs")[0]!
            .n
        ).toBe(1)
        expect(Effect.runSync(f.store.get(input.id))?.occupancy.state).toBe(
          "held"
        )
        f.finish.resolve(0)
        await Promise.all([a.completion, b.completion])
        expect(f.runtime.execute).toHaveBeenCalledTimes(1)
        expect(Effect.runSync(f.store.get(input.id))?.status).toBe("succeeded")
        expect(Effect.runSync(f.store.occupied())).toBe(false)
      }
    )
    it("bounds occupancy for distinct requests queued behind SQLite", async () => {
      const f = fixture(),
        locked = barrier(),
        release = barrier()
      const holding = run(
        f.db.transaction(() =>
          Effect.sync(() => locked.resolve()).pipe(
            Effect.andThen(Effect.promise(() => release.promise))
          )
        ),
        budget
      )
      await locked.promise
      const first = run(f.terminal.start(input), budget)
      const second = run(
        f.terminal.start({ ...input, id: "second" }),
        budget
      ).then(
        () => "unexpected",
        () => "rejected"
      )
      release.resolve()
      await holding
      const a = await first
      await f.entered.promise
      expect(await second).toBe("rejected")
      expect(f.runtime.execute).toHaveBeenCalledOnce()
      expect(Effect.runSync(f.store.get("second"))).toBeUndefined()
      f.finish.resolve(0)
      await a.completion
    })
  }
)

it("retains occupied resources after the command result until final close joins", async () => {
  const closing = barrier(),
    release = barrier()
  let closes = 0
  const f = fixture({
    close: async () => {
      if (++closes === 2) {
        closing.resolve()
        await release.promise
      }
    },
  })
  const task = await run(f.terminal.start(input))
  await f.entered.promise
  f.finish.resolve(0)
  await closing.promise
  expect(Effect.runSync(f.store.get(input.id))).toMatchObject({
    status: "succeeded",
    occupancy: { state: "cleaning" },
  })
  expect(f.terminal.state().busy).toBe(true)
  await expect(
    run(f.terminal.start({ ...input, id: "second" }))
  ).rejects.toThrow("cleanup")
  release.resolve()
  await task.completion
  expect(Effect.runSync(f.store.occupied())).toBe(false)
})

it("rejects stale command results and old cleanup owners after recovery and new admission", () => {
  const store = new TerminalStore(database())
  Effect.runSync(store.configure(1, true))
  const first = Effect.runSync(
    store.claim(input, "command", undefined, "attempt-1")
  )
  Effect.runSync(store.recover("recovery-1"))
  Effect.runSync(store.release(first.run.attemptId, true))
  expect(Effect.runSync(store.occupied())).toBe(true)
  Effect.runSync(
    store.finish(
      input.id,
      { status: "succeeded", exitCode: 0, error: null },
      checkpoint,
      undefined,
      first.run.attemptId
    )
  )
  expect(Effect.runSync(store.checkpoint())).toBeNull()
  Effect.runSync(store.release("recovery-1", true))
  Effect.runSync(
    store.claim({ ...input, id: "second" }, "command", undefined, "attempt-2")
  )
  Effect.runSync(store.release("recovery-1", true))
  Effect.runSync(store.release(first.run.attemptId, true))
  expect(Effect.runSync(store.get("second"))?.occupancy).toEqual({
    state: "held",
    ownerId: "attempt-2",
  })
  expect(Effect.runSync(store.get(input.id))?.status).toBe("interrupted")
})

it("retains blocked cleanup and permits only explicit confirmed recovery to free it", () => {
  const store = new TerminalStore(database())
  Effect.runSync(store.configure(1, true))
  Effect.runSync(store.claim(input, "command", undefined, "attempt"))
  Effect.runSync(store.release("attempt", false))
  expect(Effect.runSync(store.get(input.id))?.occupancy.state).toBe("blocked")
  expect(() =>
    Effect.runSync(
      store.claim({ ...input, id: "second" }, "command", undefined, "second")
    )
  ).toThrow("cleanup")
  Effect.runSync(store.recover("repair"))
  Effect.runSync(store.release("attempt", true))
  expect(Effect.runSync(store.occupied())).toBe(true)
  Effect.runSync(store.release("repair", true))
  expect(Effect.runSync(store.occupied())).toBe(false)
})

it("restores legacy running data without dispatch or identity/checkpoint loss and rejects future versions", () => {
  const db = database(),
    store = new TerminalStore(db)
  Effect.runSync(store.configure(1, true))
  const legacy = {
    ...input,
    authorityRevision: 1,
    status: "running",
    output: "previous output",
    exitCode: null,
    error: null,
    createdAt: 12,
    finishedAt: null,
    savedAt: null,
  }
  db.run(
    "insert into terminal_runs(id,created,record) values(?,?,?)",
    input.id,
    12,
    JSON.stringify(legacy)
  )
  db.run(
    "insert into terminal_checkpoint(id,record) values(1,?)",
    JSON.stringify(checkpoint)
  )
  const replay = Effect.runSync(
    store.claim(input, "command", undefined, "new-attempt")
  )
  expect(replay.fresh).toBe(false)
  expect(replay.run).toMatchObject({
    ...legacy,
    attemptId: "legacy:first",
    schemaVersion: 1,
    workflowVersion: 1,
    occupancy: { state: "held" },
  })
  Effect.runSync(store.recover("restored-host"))
  Effect.runSync(store.release("restored-host", true))
  expect(Effect.runSync(store.get(input.id))).toMatchObject({
    id: "first",
    createdAt: 12,
    output: "previous output",
    status: "interrupted",
  })
  expect(Effect.runSync(store.checkpoint())).toEqual(checkpoint)
  expect(() =>
    restoreCommandRecord({ ...replay.run, workflowVersion: 2 })
  ).toThrow()
  expect(() =>
    advanceCommandRecord(replay.run, {
      type: "PROGRESS",
      attemptId: 3,
      output: "bad",
    } as never)
  ).toThrow("Unsupported terminal command effect")
})

it("rechecks current authority after a held restore before dispatch", async () => {
  const restoring = barrier(),
    release = barrier()
  const f = fixture({
    restore: async () => {
      restoring.resolve()
      await release.promise
    },
  })
  const task = await run(f.terminal.start(input))
  await restoring.promise
  Effect.runSync(f.store.configure(2, false))
  release.resolve()
  await task.completion
  expect(f.runtime.execute).not.toHaveBeenCalled()
  expect(Effect.runSync(f.store.checkpoint())).toBeNull()
  expect(Effect.runSync(f.store.occupied())).toBe(false)
})

it("retains provider failure and defect together while joining command cleanup", async () => {
  const failure = new Error("provider unavailable"),
    defect = new Error("execution invariant")
  const f = fixture({
    execute: async () => {
      throw Cause.fromReasons([
        Cause.makeFailReason(failure),
        Cause.makeDieReason(defect),
      ])
    },
  })
  const task = await run(f.terminal.service.start(input))
  const exit = await Effect.runPromiseExit(task.completion)
  expect(
    Exit.isFailure(exit) &&
      exit.cause.reasons.some(
        (reason) =>
          reason._tag === "Die" &&
          typeof reason.defect === "object" &&
          reason.defect !== null &&
          "_tag" in reason.defect &&
          reason.defect._tag === "Fail"
      )
  ).toBe(true)
  expect(
    Exit.isFailure(exit) &&
      exit.cause.reasons.some(
        (reason) => reason._tag === "Die" && reason.defect === defect
      )
  ).toBe(true)
  expect(Effect.runSync(f.store.get(input.id))?.status).toBe("failed")
  expect(Effect.runSync(f.store.occupied())).toBe(false)
})

it("fences an admission queued behind SQLite when the host shuts down", async () => {
  const f = fixture(),
    locked = barrier(),
    release = barrier(),
    reading = barrier()
  const original = f.store.get.bind(f.store)
  f.store.get = (id) =>
    Effect.sync(() => reading.resolve()).pipe(Effect.andThen(original(id)))
  const holding = run(
    f.db.transaction(() =>
      Effect.sync(() => locked.resolve()).pipe(
        Effect.andThen(Effect.promise(() => release.promise))
      )
    )
  )
  await locked.promise
  const starting = run(f.terminal.service.start(input)).then(
    () => "unexpected",
    (error) => String(error)
  )
  await reading.promise
  let disposed = false
  const disposal = f.terminal.runtime.dispose().then(() => {
    disposed = true
  })
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(disposed).toBe(false)
  release.resolve()
  await holding
  await disposal
  expect(await starting).toContain("host has stopped")
  expect(f.runtime.execute).not.toHaveBeenCalled()
  expect(Effect.runSync(f.store.get(input.id))?.status).toBe("cancelled")
  expect(Effect.runSync(f.store.occupied())).toBe(false)
})

it("aborts accepted Stop even when its outcome write fails, and retains the cancellation fence", async () => {
  const entered = barrier(),
    release = barrier<number>()
  let signal: AbortSignal | undefined
  const f = fixture({
    execute: async (_command, _output, current) => {
      signal = current
      entered.resolve()
      return release.promise
    },
  })
  const task = await run(f.terminal.start(input))
  const completion = task.completion.then(
    () => false,
    () => true
  )
  await entered.promise
  f.db.run(
    "CREATE TRIGGER fail_stop BEFORE UPDATE ON terminal_runs WHEN json_extract(NEW.record,'$.status')!='running' BEGIN SELECT RAISE(ABORT,'failed cancellation outcome'); END"
  )
  await expect(run(f.terminal.cancel(input.id))).rejects.toBeDefined()
  expect(await run(f.store.cancelled(input.id))).toBe(true)
  expect(signal?.aborted).toBe(true)
  await run(
    f.db.use((orm) =>
      orm._.session
        .prepareQuery(
          { sql: "DROP TRIGGER fail_stop", params: [] },
          "objects",
          false,
          "run"
        )
        .run()
    )
  )
  release.resolve(0)
  expect(await completion).toBe(true)
  Effect.runSync(
    f.store.finish(
      input.id,
      { status: "succeeded", exitCode: 0, error: null },
      checkpoint,
      undefined,
      Effect.runSync(f.store.get(input.id))!.attemptId
    )
  )
  expect(Effect.runSync(f.store.get(input.id))?.status).toBe("cancelled")
  expect(Effect.runSync(f.store.checkpoint())).toBeNull()
})

it("fences a late checkpoint with the committed Stop even without its original caller", () => {
  const db = database(),
    store = new TerminalStore(db)
  Effect.runSync(store.configure(1, true))
  const { run: receipt } = Effect.runSync(
    store.claim(input, "command", undefined, "attempt")
  )
  db.run(
    "CREATE TRIGGER fail_stop BEFORE UPDATE ON terminal_runs WHEN json_extract(NEW.record,'$.status')!='running' BEGIN SELECT RAISE(ABORT,'failed cancellation outcome'); END"
  )
  expect(() => Effect.runSync(store.cancel(input.id))).toThrow()
  db.run("DROP TRIGGER fail_stop")
  Effect.runSync(
    store.finish(
      input.id,
      { status: "succeeded", exitCode: 0, error: null },
      checkpoint,
      undefined,
      receipt.attemptId
    )
  )
  expect(Effect.runSync(store.get(input.id))?.status).toBe("cancelled")
  expect(Effect.runSync(store.checkpoint())).toBeNull()
})

it("aborts after durable authority revocation even if cancelled outcome cannot persist", async () => {
  const entered = barrier(),
    release = barrier<number>()
  let signal: AbortSignal | undefined
  const f = fixture({
    execute: async (_command, _output, current) => {
      signal = current
      entered.resolve()
      return release.promise
    },
  })
  const task = await run(f.terminal.start(input))
  const completion = task.completion.then(
    () => false,
    () => true
  )
  await entered.promise
  f.db.run(
    "CREATE TRIGGER fail_archive BEFORE UPDATE ON terminal_runs WHEN json_extract(NEW.record,'$.status')!='running' BEGIN SELECT RAISE(ABORT,'failed archived outcome'); END"
  )
  expect(() => f.terminal.configure(2, false)).toThrow()
  expect(signal?.aborted).toBe(true)
  await run(
    f.db.use((orm) =>
      orm._.session
        .prepareQuery(
          { sql: "DROP TRIGGER fail_archive", params: [] },
          "objects",
          false,
          "run"
        )
        .run()
    )
  )
  release.resolve(0)
  expect(await completion).toBe(true)
  Effect.runSync(
    f.store.finish(
      input.id,
      { status: "succeeded", exitCode: 0, error: null },
      checkpoint,
      undefined,
      Effect.runSync(f.store.get(input.id))!.attemptId
    )
  )
  expect(Effect.runSync(f.store.checkpoint())).toBeNull()
  expect(Effect.runSync(f.store.get(input.id))?.status).not.toBe("running")
})

it("signals accepted Stop without another fallible cancellation-ledger read", async () => {
  const entered = barrier(),
    release = barrier<number>()
  let signal: AbortSignal | undefined
  const f = fixture({
    execute: async (_command, _output, current) => {
      signal = current
      entered.resolve()
      return release.promise
    },
  })
  const task = await run(f.terminal.start(input)),
    completion = task.completion.then(
      () => undefined,
      () => undefined
    )
  await entered.promise
  const original = f.store.cancelled.bind(f.store)
  f.store.cancelled = () =>
    Effect.die("cancellation ledger unavailable after commit")
  await expect(run(f.terminal.cancel(input.id))).rejects.toBeDefined()
  expect(signal?.aborted).toBe(true)
  f.store.cancelled = original
  expect(await run(f.store.cancelled(input.id))).toBe(true)
  release.resolve(0)
  await completion
  expect(Effect.runSync(f.store.checkpoint())).toBeNull()
  expect(Effect.runSync(f.store.get(input.id))?.status).not.toBe("succeeded")
})

it("signals committed authority revocation without another command-row read", async () => {
  const entered = barrier(),
    release = barrier<number>()
  let signal: AbortSignal | undefined
  const f = fixture({
    execute: async (_command, _output, current) => {
      signal = current
      entered.resolve()
      return release.promise
    },
  })
  const task = await run(f.terminal.start(input)),
    completion = task.completion.then(
      () => undefined,
      () => undefined
    )
  await entered.promise
  const original = f.store.get.bind(f.store)
  f.store.get = () => Effect.die("command row unavailable after revocation")
  await expect(
    run(f.terminal.service.configure(2, false))
  ).rejects.toBeDefined()
  expect(signal?.aborted).toBe(true)
  f.store.get = original
  release.resolve(0)
  await completion
  expect(Effect.runSync(f.store.checkpoint())).toBeNull()
  expect(Effect.runSync(f.store.get(input.id))?.status).not.toBe("succeeded")
})
