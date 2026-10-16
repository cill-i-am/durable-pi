import { relayTerminal } from "../src/terminal/adapters/socket"
import { Cause, Effect, Exit, Fiber } from "effect"
import type { Sandbox } from "@cloudflare/sandbox-v0"
import { describe, expect, it, vi } from "vitest"
import { readBounded } from "../src/terminal/adapters/stream"
import { Terminal, type TerminalRuntime } from "./terminal-fixture"
import { TerminalStore } from "../src/terminal/adapters/sqlite"
import { readCommand, sandboxRuntime } from "../src/terminal/adapters/sandbox"
import { MAX_OUTPUT, TerminalFailure } from "../src/terminal/contracts"
import { database } from "./database"

const input = { id: "command", command: "printf hello" }
const run = Effect.runPromise
const checkpoint = { key: "private/file", sha256: "test", size: 1, savedAt: 42 }
function fixture(overrides: Partial<TerminalRuntime> = {}) {
  const db = database()
  const repository = new TerminalStore(db)
  const runtime: TerminalRuntime = {
    close: vi.fn(async () => {}),
    restore: vi.fn(async () => {}),
    execute: vi.fn(async (_, append) => {
      append("hello")
      return 0
    }),
    snapshot: vi.fn(async () => new Uint8Array([1])),
    ...overrides,
  }
  const backups = {
    read: vi.fn(async () => new Uint8Array([1])),
    write: vi.fn(async () => checkpoint),
  }
  const terminal = new Terminal(repository, runtime, backups, relayTerminal)
  terminal.configure(0, true)
  return { db, terminal, repository, runtime, backups }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
describe("Linux commands", () => {
  it("keeps an admitted command alive after its request scope closes", async () => {
    const started = deferred<void>(),
      done = deferred<number>()
    const f = fixture({
      execute: async () => {
        started.resolve()
        return done.promise
      },
    })
    const task = await Effect.runPromise(
      Effect.scoped(f.terminal.service.start(input))
    )
    await started.promise
    expect(Effect.runSync(f.repository.get(input.id))?.status).toBe("running")
    done.resolve(0)
    await f.terminal.runtime.runPromise(task.completion)
    expect(Effect.runSync(f.repository.get(input.id))?.status).toBe("succeeded")
  })
  it("awaits noncooperative foreign work during actor scope shutdown", async () => {
    const restoring = deferred<void>(),
      settled = deferred<void>(),
      closing = deferred<void>()
    let closes = 0
    const f = fixture({
      restore: async () => {
        restoring.resolve()
        await settled.promise
      },
      close: async () => {
        if (++closes >= 2) closing.resolve()
      },
    })
    const task = await run(f.terminal.start(input))
    const completion = task.completion.catch(() => {})
    await restoring.promise
    let disposed = false
    const disposal = f.terminal.runtime.dispose().then(() => {
      disposed = true
    })
    await closing.promise
    expect(disposed).toBe(false)
    expect(Effect.runSync(f.repository.checkpoint())).toBeNull()
    settled.resolve()
    await disposal
    await completion
    expect(f.runtime.execute).not.toHaveBeenCalled()
    expect(f.runtime.snapshot).not.toHaveBeenCalled()
    expect(Effect.runSync(f.repository.get(input.id))?.status).not.toBe(
      "running"
    )
    await expect(
      run(f.terminal.service.start({ ...input, id: "after-stop" }))
    ).rejects.toThrow("host has stopped")
    expect(Effect.runSync(f.repository.get("after-stop"))).toBeUndefined()
  })
  it("awaits cleanup even when recording a failed outcome also fails", async () => {
    const f = fixture({
      execute: async () => {
        throw new Error("execution failure")
      },
    })
    f.db.run(
      "CREATE TRIGGER fail_finish BEFORE UPDATE ON terminal_runs WHEN json_extract(NEW.record,'$.status')!='running' BEGIN SELECT RAISE(ABORT,'storage failure'); END"
    )
    const task = await run(f.terminal.start(input))
    await expect(task.completion).rejects.toBeDefined()
    expect(f.runtime.close).toHaveBeenCalledTimes(3)
    expect(f.terminal.state().busy).toBe(false)
    f.db.run("DROP TRIGGER fail_finish")
    await f.terminal.recover()
    expect(Effect.runSync(f.repository.get(input.id))?.status).toBe(
      "interrupted"
    )
  })
  it("joins noncooperative recovery close before actor runtime disposal completes", async () => {
    const closing = deferred<void>(),
      closed = deferred<void>()
    const f = fixture({
      close: vi.fn(async () => {
        closing.resolve()
        await closed.promise
      }),
    })
    Effect.runSync(f.repository.admit(input))
    const recovery = f.terminal.recover().catch(() => {})
    await closing.promise
    let disposed = false
    const disposal = f.terminal.runtime.dispose().then(() => {
      disposed = true
    })
    await vi.waitFor(async () => {
      await expect(
        run(f.terminal.service.start({ ...input, id: "during-disposal" }))
      ).rejects.toThrow("host has stopped")
    })
    expect(Effect.runSync(f.repository.get(input.id))?.status).toBe(
      "interrupted"
    )
    expect(disposed).toBe(false)
    expect((await run(f.terminal.service.state())).busy).toBe(true)
    closed.resolve()
    await disposal
    await recovery
    expect((await run(f.terminal.service.state())).busy).toBe(false)
    expect(f.runtime.close).toHaveBeenCalledOnce()
  })
  it("retains an archive revocation that arrives after restore without cancelling newer work", async () => {
    const started = deferred<void>(),
      done = deferred<number>()
    const f = fixture({
      execute: async () => {
        started.resolve()
        return done.promise
      },
    })
    f.terminal.configure(1, true)
    const previous = await run(f.terminal.start(input))
    await started.promise
    f.terminal.configure(3, true)
    f.terminal.configure(3, true, 2)
    expect(Effect.runSync(f.repository.get(input.id))?.status).toBe("cancelled")
    done.resolve(0)
    await previous.completion
    expect(Effect.runSync(f.repository.checkpoint())).toBeNull()
    const newer = await run(f.terminal.start({ ...input, id: "restored" }))
    f.terminal.configure(2, false)
    await newer.completion
    expect(Effect.runSync(f.repository.get("restored"))?.status).toBe(
      "succeeded"
    )
    expect(Effect.runSync(f.repository.authority())).toMatchObject({
      revision: 3,
      active: 1,
      revokedThrough: 2,
    })
  })
  it("fences checkpoint commit even when authority revocation is applied directly", () => {
    const f = fixture()
    Effect.runSync(f.repository.admit(input))
    Effect.runSync(f.repository.configure(3, true, 2))
    Effect.runSync(
      f.repository.finish(
        input.id,
        { status: "succeeded", exitCode: 0, error: null },
        checkpoint
      )
    )
    expect(Effect.runSync(f.repository.get(input.id))?.status).toBe("cancelled")
    expect(Effect.runSync(f.repository.checkpoint())).toBeNull()
  })
  it("durably admits once and atomically saves output with a workspace checkpoint", async () => {
    const f = fixture()
    f.runtime.execute = vi.fn(async (_, append) => {
      expect(Effect.runSync(f.repository.get(input.id))?.status).toBe("running")
      append("hello")
      return 0
    })
    await (
      await run(f.terminal.start(input))
    ).completion
    expect(Effect.runSync(f.repository.get(input.id))).toMatchObject({
      status: "succeeded",
      output: "hello",
      savedAt: 42,
    })
    expect(Effect.runSync(f.repository.checkpoint())).toEqual(checkpoint)
    await (
      await run(f.terminal.start(input))
    ).completion
    expect(f.runtime.execute).toHaveBeenCalledTimes(1)
    await expect(
      run(f.terminal.start({ ...input, command: "other" }))
    ).rejects.toThrow("different input")
    await (
      await run(f.terminal.start({ ...input, id: "second" }))
    ).completion
    expect(f.backups.read).toHaveBeenCalledWith(checkpoint)
    expect(f.runtime.restore).toHaveBeenLastCalledWith(
      new Uint8Array([1]),
      expect.any(AbortSignal),
      true
    )
    expect(Effect.runSync(f.repository.list())[0]).not.toHaveProperty("output")
  })
  it("retains admission while cancelled startup settles and fences every later phase", async () => {
    const started = deferred<void>(),
      restore = deferred<void>()
    const f = fixture({
      restore: async () => {
        started.resolve()
        await restore.promise
      },
    })
    const task = await run(f.terminal.start(input))
    await started.promise
    await run(f.terminal.cancel(input.id))
    expect(Effect.runSync(f.repository.get(input.id))?.status).toBe("cancelled")
    await expect(
      run(f.terminal.start({ ...input, id: "second" }))
    ).rejects.toThrow("cleanup")
    restore.resolve()
    await task.completion
    expect(f.runtime.execute).not.toHaveBeenCalled()
    expect(f.runtime.snapshot).not.toHaveBeenCalled()
    expect(f.backups.write).not.toHaveBeenCalled()
    expect(f.runtime.close).toHaveBeenCalledTimes(3)
    expect(f.terminal.state().busy).toBe(false)
  })
  it("does not publish a checkpoint that completes after cancellation", async () => {
    const writing = deferred<void>(),
      done = deferred<typeof checkpoint>()
    const f = fixture()
    f.backups.write = vi.fn(async () => {
      writing.resolve()
      return done.promise
    })
    const task = await run(f.terminal.start(input))
    await writing.promise
    await run(f.terminal.cancel(input.id))
    done.resolve(checkpoint)
    await task.completion
    expect(Effect.runSync(f.repository.checkpoint())).toBeNull()
    expect(Effect.runSync(f.repository.get(input.id))?.status).toBe("cancelled")
  })
  it("bounds output and destroys a runaway command", async () => {
    const f = fixture({
      execute: async (_, append) => {
        append("x".repeat(MAX_OUTPUT + 1))
        return 0
      },
    })
    await (
      await run(f.terminal.start(input))
    ).completion
    expect(Effect.runSync(f.repository.get(input.id))).toMatchObject({
      status: "failed",
      output: "x".repeat(MAX_OUTPUT),
    })
    expect(Effect.runSync(f.repository.checkpoint())).toBeNull()
    expect(f.runtime.close).toHaveBeenCalledTimes(3)
  })
  it("keeps terminal outcomes immutable and never replays interrupted work", async () => {
    const f = fixture()
    Effect.runSync(f.repository.admit(input))
    await f.terminal.recover()
    await (
      await run(f.terminal.start(input))
    ).completion
    expect(Effect.runSync(f.repository.get(input.id))?.status).toBe(
      "interrupted"
    )
    expect(f.runtime.execute).not.toHaveBeenCalled()
    await run(f.terminal.cancel(input.id))
    expect(Effect.runSync(f.repository.get(input.id))?.status).toBe(
      "interrupted"
    )
  })
  it("destroys a surviving container after restart before reporting idle or admitting", async () => {
    const closed = deferred<void>()
    const f = fixture({ close: vi.fn(() => closed.promise) })
    Effect.runSync(f.repository.admit(input))
    const recovering = f.terminal.recover()
    expect(f.terminal.state().busy).toBe(true)
    expect(Effect.runSync(f.repository.get(input.id))?.status).toBe(
      "interrupted"
    )
    await expect(
      run(f.terminal.start({ ...input, id: "new" }))
    ).rejects.toThrow("cleanup")
    closed.resolve()
    await recovering
    expect(f.terminal.state().busy).toBe(false)
    expect(f.runtime.close).toHaveBeenCalledTimes(1)
  })
  it("fails closed on unconfirmed cleanup and permits an explicit recovery retry", async () => {
    const f = fixture({
      close: vi
        .fn()
        .mockRejectedValueOnce(new Error("unavailable"))
        .mockResolvedValue(undefined),
    })
    await f.terminal.recover()
    expect(f.terminal.state().cleanupError).toContain("not be confirmed")
    await expect(run(f.terminal.start(input))).rejects.toThrow("cleanup")
    await f.terminal.recover()
    expect(f.terminal.state().cleanupError).toBeNull()
  })
  it("persists cancellation before admission without executing late requests", async () => {
    const f = fixture()
    await run(f.terminal.cancel(input.id))
    await (
      await run(f.terminal.start(input))
    ).completion
    expect(Effect.runSync(f.repository.get(input.id))?.status).toBe("cancelled")
    expect(f.runtime.execute).not.toHaveBeenCalled()
  })
  it("rejects stale reactivation and stops running work on archival", async () => {
    const started = deferred<void>(),
      done = deferred<number>()
    const f = fixture({
      execute: async () => {
        started.resolve()
        return done.promise
      },
    })
    const task = await run(f.terminal.start(input))
    await started.promise
    f.terminal.configure(2, false)
    f.terminal.configure(1, true)
    expect(Effect.runSync(f.repository.get(input.id))?.status).toBe("cancelled")
    done.resolve(0)
    await task.completion
    await expect(
      run(f.terminal.start({ ...input, id: "other" }))
    ).rejects.toThrow("not active")
    f.terminal.configure(3, true)
    expect(Effect.runSync(f.repository.authority())?.active).toBe(1)
    expect(f.backups.write).not.toHaveBeenCalled()
  })
  it("does not expose another bot's output or checkpoint", async () => {
    const a = fixture(),
      b = fixture()
    await (
      await run(a.terminal.start(input))
    ).completion
    expect(Effect.runSync(b.repository.get(input.id))).toBeUndefined()
    expect(Effect.runSync(b.repository.checkpoint())).toBeNull()
  })
})
describe("untrusted sandbox streams", () => {
  const stream = (value: string) => new Response(value).body!
  it("parses real SSE shape across chunks and returns a nonzero exit code", async () => {
    const append = vi.fn()
    const bytes = new TextEncoder().encode(
      'data: {"type":"stdout","data":"café 🧭"}\n\ndata: {"type":"stderr","data":"warning"}\n\ndata: {"type":"complete","exitCode":7}\n\n'
    )
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const byte of bytes) c.enqueue(new Uint8Array([byte]))
        c.close()
      },
    })
    expect(await readCommand(body, append, new AbortController().signal)).toBe(
      7
    )
    expect(append.mock.calls).toEqual([["café 🧭"], ["warning"]])
  })
  it("rejects missing completion and excessive protocol output", async () => {
    await expect(
      readCommand(
        stream('data: {"type":"stdout","data":"hi"}\n\n'),
        () => {},
        new AbortController().signal
      )
    ).rejects.toThrow("Missing")
    await expect(
      readCommand(
        stream("x".repeat(256001)),
        () => {},
        new AbortController().signal
      )
    ).rejects.toThrow("limit")
  })
  it("cancels an untrusted archive stream on bounds and on Stop", async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(10))
      },
      cancel,
    })
    await expect(
      readBounded(body, 9, new AbortController().signal)
    ).rejects.toThrow("limit")
    expect(cancel).toHaveBeenCalledTimes(1)
    const stopped = vi.fn(),
      controller = new AbortController()
    const reading = readBounded(
      new ReadableStream({ cancel: stopped }),
      10,
      controller.signal
    )
    controller.abort()
    await expect(reading).rejects.toThrow("Stopped")
    expect(stopped).toHaveBeenCalledTimes(1)
  })
  it("cancels a command stream when output admission fails or Stop interrupts a read", async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            'data: {"type":"stdout","data":"output"}\n\n'
          )
        )
      },
      cancel,
    })
    await expect(
      readCommand(
        body,
        () => {
          throw new TerminalFailure({ message: "Output limit" })
        },
        new AbortController().signal
      )
    ).rejects.toThrow("Output limit")
    expect(cancel).toHaveBeenCalledOnce()
    const stopped = vi.fn(),
      controller = new AbortController()
    const reading = readCommand(
      new ReadableStream({ cancel: stopped }),
      () => {},
      controller.signal
    )
    controller.abort()
    await expect(reading).rejects.toThrow("Stopped")
    expect(stopped).toHaveBeenCalledOnce()
  })
})

describe("Pi command service", () => {
  it("waits for teardown before reporting completion so sequential commands can enter", async () => {
    const { runCommand } = await import("../src/terminal/adapters/service")
    const { terminalRequest } = await import("../src/terminal/adapters/http")
    const closed = deferred<void>(),
      closing = deferred<void>()
    let closes = 0
    const f = fixture({
      close: async () => {
        if (++closes === 2) {
          closing.resolve()
          await closed.promise
        }
      },
    })
    const service = {
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname.replace("/owner/", "")
        return run(terminalRequest(f.terminal.service, request, path, () => {}))
      },
    }
    let reported = false
    const pending = run(runCommand(service, "owner", input)).then((value) => {
      reported = true
      return value
    })
    await closing.promise
    await new Promise((resolve) => setTimeout(resolve, 550))
    expect(reported).toBe(false)
    closed.resolve()
    expect((await pending).status).toBe("succeeded")
    expect(
      (await run(runCommand(service, "owner", { ...input, id: "second" })))
        .status
    ).toBe("succeeded")
  })
  it("stops an admitted request even if Stop arrives before its start request", async () => {
    const { runCommand } = await import("../src/terminal/adapters/service")
    const { terminalRequest } = await import("../src/terminal/adapters/http")
    const admitted = deferred<void>(),
      release = deferred<void>(),
      f = fixture()
    const service = {
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname.replace("/owner/", "")
        if (path === "terminal/run") {
          admitted.resolve()
          await release.promise
        }
        return run(terminalRequest(f.terminal.service, request, path, () => {}))
      },
    }
    const controller = new AbortController()
    const pending = Effect.runPromiseExit(runCommand(service, "owner", input), {
      signal: controller.signal,
    })
    await admitted.promise
    controller.abort()
    await Promise.resolve()
    release.resolve()
    const exit = await pending
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(Effect.runSync(f.repository.get(input.id))?.status).toBe("cancelled")
    expect(f.runtime.execute).not.toHaveBeenCalled()
  })
})

describe("interactive workspace ownership", () => {
  it("retains the connection claim and closes a late socket after request interruption", async () => {
    const connecting = deferred<void>(),
      interrupted = deferred<void>(),
      available = deferred<void>()
    const socket = { accept: vi.fn(), close: vi.fn() }
    const f = fixture({
      openInteractive: async () => ({
        connect: async (request) => {
          request.signal.addEventListener(
            "abort",
            () => interrupted.resolve(),
            { once: true }
          )
          connecting.resolve()
          await available.promise
          return { webSocket: socket } as unknown as Response
        },
        close: async () => {},
      }),
    })
    const task = await run(f.terminal.startSession("interrupted-socket"))
    await vi.waitFor(() =>
      expect(f.terminal.state().session?.phase).toBe("ready")
    )
    const session = f.terminal.session("interrupted-socket")
    const request = new Request("https://terminal.internal")
    const fiber = Effect.runFork(session.connect(request))
    await connecting.promise
    let settled = false
    const interruption = run(Fiber.interrupt(fiber)).then(() => {
      settled = true
    })
    await interrupted.promise
    expect(settled).toBe(false)
    await expect(run(session.connect(request))).rejects.toThrow("another panel")
    await run(session.save())
    expect(f.backups.write).not.toHaveBeenCalled()
    expect(f.terminal.state().busy).toBe(true)
    available.resolve()
    await interruption
    const exit = await run(Fiber.await(fiber))
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    await task.completion
    expect(socket.close).toHaveBeenCalledOnce()
    expect(Effect.runSync(f.repository.get("interrupted-socket"))?.status).toBe(
      "succeeded"
    )
    expect(f.terminal.state().busy).toBe(false)
  })
  it("holds the workspace until Save closes the shell and checkpoints it", async () => {
    const ready = deferred<void>(),
      close = vi.fn(async () => {})
    const f = fixture({
      openInteractive: async () => {
        ready.resolve()
        return { connect: async () => new Response(), close }
      },
    })
    const task = await run(f.terminal.startSession("interactive"))
    await ready.promise
    await vi.waitFor(() =>
      expect(f.terminal.state().session?.phase).toBe("ready")
    )
    await expect(run(f.terminal.start(input))).rejects.toThrow("cleanup")
    await run(f.terminal.session("interactive").save())
    await task.completion
    expect(close).toHaveBeenCalledTimes(1)
    expect(Effect.runSync(f.repository.get("interactive"))).toMatchObject({
      kind: "session",
      status: "succeeded",
      output: "",
      savedAt: 42,
    })
    expect(f.runtime.execute).not.toHaveBeenCalled()
    expect(f.terminal.state().session).toBeNull()
  })
  it("discards changes on Stop without checkpointing", async () => {
    const f = fixture({
      openInteractive: async () => ({
        connect: async () => new Response(),
        close: async () => {},
      }),
    })
    const task = await run(f.terminal.startSession("interactive"))
    await vi.waitFor(() =>
      expect(f.terminal.state().session?.phase).toBe("ready")
    )
    await run(f.terminal.cancel("interactive"))
    await task.completion
    expect(f.backups.write).not.toHaveBeenCalled()
    expect(Effect.runSync(f.repository.get("interactive"))?.status).toBe(
      "cancelled"
    )
  })
  it("expires without authenticated renewals and does not publish changes", async () => {
    vi.useFakeTimers()
    try {
      const f = fixture({
        openInteractive: async () => ({
          connect: async () => new Response(),
          close: async () => {},
        }),
      })
      const task = await run(f.terminal.startSession("interactive"))
      await vi.advanceTimersByTimeAsync(1)
      expect(f.terminal.state().session?.phase).toBe("ready")
      await vi.advanceTimersByTimeAsync(30000)
      await task.completion
      expect(f.backups.write).not.toHaveBeenCalled()
      expect(f.terminal.state().busy).toBe(false)
      expect(Effect.runSync(f.repository.get("interactive"))?.status).toBe(
        "failed"
      )
    } finally {
      vi.useRealTimers()
    }
  })
  it("cannot reopen an ended session by retrying its old operation ID", async () => {
    const f = fixture({
      openInteractive: async () => ({
        connect: async () => new Response(),
        close: async () => {},
      }),
    })
    const first = await run(f.terminal.startSession("interactive"))
    await run(f.terminal.cancel("interactive"))
    await first.completion
    const retry = await run(f.terminal.startSession("interactive"))
    await retry.completion
    expect(retry.run.status).toBe("cancelled")
    expect(f.terminal.state().session).toBeNull()
    await expect(
      run(
        f.terminal.start({ id: "interactive", command: "Interactive terminal" })
      )
    ).rejects.toThrow("different input")
  })
})

it("revokes a pre-archive PTY after restore while preserving a newly admitted PTY", async () => {
  const f = fixture({
    openInteractive: async () => ({
      connect: async () => new Response(),
      close: async () => {},
    }),
  })
  f.terminal.configure(1, true)
  const old = await run(f.terminal.startSession("old-session"))
  await vi.waitFor(() =>
    expect(f.terminal.state().session?.phase).toBe("ready")
  )
  f.terminal.configure(3, true, 2)
  await old.completion
  expect(Effect.runSync(f.repository.get("old-session"))?.status).toBe(
    "cancelled"
  )
  expect(f.backups.write).not.toHaveBeenCalled()
  const restored = await run(f.terminal.startSession("restored-session"))
  await vi.waitFor(() =>
    expect(f.terminal.state().session?.phase).toBe("ready")
  )
  f.terminal.configure(2, false)
  expect(f.terminal.session("restored-session").live).toBe(true)
  await run(f.terminal.session("restored-session").save())
  await restored.completion
  expect(Effect.runSync(f.repository.get("restored-session"))?.status).toBe(
    "succeeded"
  )
  expect(f.backups.write).toHaveBeenCalledOnce()
})

it.each(["cancel", "save"] as const)(
  "holds admission and destroys late PTY startup during %s",
  async (action) => {
    const gate = deferred<void>()
    let alive = false
    const socket = { accept: vi.fn(), close: vi.fn() }
    const f = fixture({
      close: async () => {
        alive = false
      },
      openInteractive: async () => ({
        connect: async () => {
          await gate.promise
          alive = true
          return { webSocket: socket } as unknown as Response
        },
        close: vi.fn(async () => {}),
      }),
    })
    const task = await run(f.terminal.startSession("interactive"))
    await vi.waitFor(() =>
      expect(f.terminal.state().session?.phase).toBe("ready")
    )
    const session = f.terminal.session("interactive")
    const pending = run(
      session.connect(new Request("https://terminal.internal"))
    )
    const rejected = expect(pending).rejects.toThrow("ended")
    if (action === "cancel") await run(f.terminal.cancel("interactive"))
    else await run(session.save())
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(f.terminal.state().busy).toBe(true)
    expect(f.backups.write).not.toHaveBeenCalled()
    await expect(run(f.terminal.start(input))).rejects.toThrow("cleanup")
    gate.resolve()
    await rejected
    await task.completion
    expect(alive).toBe(false)
    expect(socket.close).toHaveBeenCalledOnce()
    expect(f.terminal.state().busy).toBe(false)
    expect(Effect.runSync(f.repository.get("interactive"))?.status).toBe(
      action === "save" ? "succeeded" : "cancelled"
    )
  }
)

describe("owner-controlled terminal internet access", () => {
  it("defaults to enabled, preserves saved restrictions, rejects stale updates, and isolates bots", () => {
    const f = fixture()
    expect(f.terminal.state().networkPolicy).toEqual({
      revision: 0,
      unrestricted: true,
    })
    f.terminal.configureNetwork({ revision: 0, unrestricted: true })
    expect(Effect.runSync(new TerminalStore(f.db).networkPolicy())).toEqual({
      revision: 1,
      unrestricted: true,
    })
    expect(() =>
      f.terminal.configureNetwork({ revision: 0, unrestricted: false })
    ).toThrow("changed")
    expect(fixture().terminal.state().networkPolicy.unrestricted).toBe(true)
    f.terminal.configureNetwork({ revision: 1, unrestricted: false })
    expect(
      Effect.runSync(new TerminalStore(f.db).networkPolicy()).unrestricted
    ).toBe(false)
    f.terminal.configure(1, false)
    expect(() =>
      f.terminal.configureNetwork({ revision: 2, unrestricted: false })
    ).toThrow("Restore this bot")
  })
  it("pins network access to the command receipt and never replays after a setting change", async () => {
    const f = fixture()
    f.terminal.configureNetwork({ revision: 0, unrestricted: true })
    await (
      await run(f.terminal.start(input))
    ).completion
    expect(
      Effect.runSync(f.repository.get(input.id))?.networkUnrestricted
    ).toBe(true)
    expect(f.runtime.restore).toHaveBeenLastCalledWith(
      null,
      expect.any(AbortSignal),
      true
    )
    f.terminal.configureNetwork({ revision: 1, unrestricted: false })
    await (
      await run(f.terminal.start(input))
    ).completion
    expect(f.runtime.execute).toHaveBeenCalledTimes(1)
    await (
      await run(f.terminal.start({ ...input, id: "offline" }))
    ).completion
    expect(f.runtime.restore).toHaveBeenLastCalledWith(
      new Uint8Array([1]),
      expect.any(AbortSignal),
      false
    )
    expect(
      Effect.runSync(f.repository.get("offline"))?.networkUnrestricted
    ).toBe(false)
  })
  it("rejects network changes during commands, interactive sessions, and recovery", async () => {
    const started = deferred<void>(),
      done = deferred<number>()
    const f = fixture({
      execute: async () => {
        started.resolve()
        return done.promise
      },
    })
    const command = await run(f.terminal.start(input))
    await started.promise
    expect(() =>
      f.terminal.configureNetwork({ revision: 0, unrestricted: true })
    ).toThrow("Stop or save")
    done.resolve(0)
    await command.completion
    const close = deferred<void>()
    f.runtime.close = () => close.promise
    const recovery = f.terminal.recover()
    expect(() =>
      f.terminal.configureNetwork({ revision: 0, unrestricted: true })
    ).toThrow("cleanup")
    close.resolve()
    await recovery
    const session = await run(f.terminal.startSession("interactive"))
    expect(() =>
      f.terminal.configureNetwork({ revision: 0, unrestricted: true })
    ).toThrow("Stop or save")
    await session.completion
    expect(f.terminal.state().networkPolicy.unrestricted).toBe(true)
  })
})

it("applies network access to the native Sandbox instance before each cold start", async () => {
  const starts: boolean[] = []
  const sandbox = {
    enableInternet: false,
    destroy: vi.fn(async () => {}),
    startAndWaitForPorts: vi.fn(async () => {
      starts.push(sandbox.enableInternet)
    }),
    mkdir: vi.fn(async () => {}),
  }
  const runtime = sandboxRuntime(sandbox as unknown as Sandbox)
  const signal = new AbortController().signal
  await runtime.close()
  await runtime.restore(null, signal, true)
  await runtime.close()
  await runtime.restore(null, signal, false)
  expect(starts).toEqual([true, false])
  await expect(
    runtime.restore(null, AbortSignal.abort(), true)
  ).rejects.toThrow("Stopped")
  expect(sandbox.enableInternet).toBe(false)
})

it("reports only newly committed terminal outcomes and restart interruptions", () => {
  const db = database(),
    observed = vi.fn()
  const store = new TerminalStore(db, observed)
  Effect.runSync(store.configure(0, true))
  Effect.runSync(store.admit(input))
  Effect.runSync(
    store.finish(input.id, { status: "succeeded", exitCode: 0, error: null })
  )
  Effect.runSync(
    store.finish(input.id, {
      status: "failed",
      exitCode: 1,
      error: "late replay",
    })
  )
  expect(observed).toHaveBeenCalledTimes(1)
  expect(observed.mock.calls[0]?.[0]).toMatchObject({
    id: input.id,
    status: "succeeded",
  })
  Effect.runSync(store.admit({ ...input, id: "interrupted" }))
  Effect.runSync(new TerminalStore(db, observed).recover())
  Effect.runSync(new TerminalStore(db, observed).recover())
  expect(observed).toHaveBeenCalledTimes(2)
  expect(observed.mock.calls[1]?.[0]).toMatchObject({
    id: "interrupted",
    status: "interrupted",
  })
})
it("does not let failed telemetry change a committed command result", () => {
  const store = new TerminalStore(database(), () => {
    throw new Error("telemetry failed")
  })
  Effect.runSync(store.configure(0, true))
  Effect.runSync(store.admit(input))
  expect(
    Effect.runSync(
      store.finish(input.id, { status: "succeeded", exitCode: 0, error: null })
    ).status
  ).toBe("succeeded")
})

it("retains a cancellation fence when outcome publication fails and observes only a committed finish", () => {
  const db = database(),
    observed = vi.fn(),
    store = new TerminalStore(db, observed)
  Effect.runSync(store.configure(0, true))
  Effect.runSync(store.admit(input))
  db.run(
    "CREATE TRIGGER reject_cancelled_command BEFORE UPDATE ON terminal_runs WHEN json_extract(NEW.record,'$.status')='cancelled' BEGIN SELECT RAISE(ABORT,'completion unavailable'); END"
  )
  expect(
    Effect.runSync(store.cancel(input.id).pipe(Effect.result))
  ).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "TerminalStorageError" },
  })
  expect(db.all("SELECT id FROM terminal_cancellations")).toEqual([
    { id: input.id },
  ])
  expect(observed).not.toHaveBeenCalled()
  expect(Effect.runSync(store.get(input.id))?.status).toBe("running")
  db.run("DROP TRIGGER reject_cancelled_command")
  expect(Effect.runSync(store.cancel(input.id))?.status).toBe("cancelled")
  expect(observed).toHaveBeenCalledOnce()
})
