import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"
import { Terminal, type TerminalRuntime } from "../src/terminal/terminal"
import { TerminalStore } from "../src/terminal/adapters/sqlite"
import { readBounded, readCommand } from "../src/terminal/adapters/sandbox"
import { MAX_OUTPUT } from "../src/terminal/contracts"
import { database } from "./database"

const input = { id: "command", command: "printf hello" }
const run = Effect.runPromise
const checkpoint = { key: "private/file", sha256: "test", size: 1, savedAt: 42 }
function fixture(overrides: Partial<TerminalRuntime> = {}) {
  const repository = new TerminalStore(database())
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
  const terminal = new Terminal(repository, runtime, backups)
  terminal.configure(0, true)
  return { terminal, repository, runtime, backups }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
describe("Linux commands", () => {
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
    expect(f.repository.get(input.id)?.status).toBe("cancelled")
    done.resolve(0)
    await previous.completion
    expect(f.repository.checkpoint()).toBeNull()
    const newer = await run(f.terminal.start({ ...input, id: "restored" }))
    f.terminal.configure(2, false)
    await newer.completion
    expect(f.repository.get("restored")?.status).toBe("succeeded")
    expect(f.repository.authority()).toMatchObject({
      revision: 3,
      active: 1,
      revokedThrough: 2,
    })
  })
  it("fences checkpoint commit even when authority revocation is applied directly", () => {
    const f = fixture()
    f.repository.admit(input)
    f.repository.configure(3, true, 2)
    f.repository.finish(
      input.id,
      { status: "succeeded", exitCode: 0, error: null },
      checkpoint
    )
    expect(f.repository.get(input.id)?.status).toBe("cancelled")
    expect(f.repository.checkpoint()).toBeNull()
  })
  it("durably admits once and atomically saves output with a workspace checkpoint", async () => {
    const f = fixture()
    f.runtime.execute = vi.fn(async (_, append) => {
      expect(f.repository.get(input.id)?.status).toBe("running")
      append("hello")
      return 0
    })
    await (
      await run(f.terminal.start(input))
    ).completion
    expect(f.repository.get(input.id)).toMatchObject({
      status: "succeeded",
      output: "hello",
      savedAt: 42,
    })
    expect(f.repository.checkpoint()).toEqual(checkpoint)
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
      expect.any(AbortSignal)
    )
    expect(f.repository.list()[0]).not.toHaveProperty("output")
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
    expect(f.repository.get(input.id)?.status).toBe("cancelled")
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
    expect(f.repository.checkpoint()).toBeNull()
    expect(f.repository.get(input.id)?.status).toBe("cancelled")
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
    expect(f.repository.get(input.id)).toMatchObject({
      status: "failed",
      output: "x".repeat(MAX_OUTPUT),
    })
    expect(f.repository.checkpoint()).toBeNull()
    expect(f.runtime.close).toHaveBeenCalledTimes(3)
  })
  it("keeps terminal outcomes immutable and never replays interrupted work", async () => {
    const f = fixture()
    f.repository.admit(input)
    await f.terminal.recover()
    await (
      await run(f.terminal.start(input))
    ).completion
    expect(f.repository.get(input.id)?.status).toBe("interrupted")
    expect(f.runtime.execute).not.toHaveBeenCalled()
    await run(f.terminal.cancel(input.id))
    expect(f.repository.get(input.id)?.status).toBe("interrupted")
  })
  it("destroys a surviving container after restart before reporting idle or admitting", async () => {
    const closed = deferred<void>()
    const f = fixture({ close: vi.fn(() => closed.promise) })
    f.repository.admit(input)
    const recovering = f.terminal.recover()
    expect(f.terminal.state().busy).toBe(true)
    expect(f.repository.get(input.id)?.status).toBe("interrupted")
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
    expect(f.repository.get(input.id)?.status).toBe("cancelled")
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
    expect(f.repository.get(input.id)?.status).toBe("cancelled")
    done.resolve(0)
    await task.completion
    await expect(
      run(f.terminal.start({ ...input, id: "other" }))
    ).rejects.toThrow("not active")
    f.terminal.configure(3, true)
    expect(f.repository.authority()?.active).toBe(1)
    expect(f.backups.write).not.toHaveBeenCalled()
  })
  it("does not expose another bot's output or checkpoint", async () => {
    const a = fixture(),
      b = fixture()
    await (
      await run(a.terminal.start(input))
    ).completion
    expect(b.repository.get(input.id)).toBeUndefined()
    expect(b.repository.checkpoint()).toBeNull()
  })
})
describe("untrusted sandbox streams", () => {
  const stream = (value: string) => new Response(value).body!
  it("parses real SSE shape across chunks and returns a nonzero exit code", async () => {
    const append = vi.fn()
    const bytes = new TextEncoder().encode(
      'data: {"type":"stdout","data":"hello"}\n\ndata: {"type":"complete","exitCode":7}\n\n'
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
    expect(append).toHaveBeenCalledWith("hello")
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
})

describe("Pi command service", () => {
  it("waits for teardown before reporting completion so sequential commands can enter", async () => {
    const { runCommand } = await import("../src/terminal/adapters/service")
    const { terminalRequest } = await import("../src/terminal/http")
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
        return run(terminalRequest(f.terminal, request, path, () => {}))
      },
    } as unknown as Fetcher
    let reported = false
    const pending = runCommand(
      service,
      "owner",
      input,
      new AbortController().signal
    ).then((value) => {
      reported = true
      return value
    })
    await closing.promise
    await new Promise((resolve) => setTimeout(resolve, 550))
    expect(reported).toBe(false)
    closed.resolve()
    expect((await pending).status).toBe("succeeded")
    expect(
      (
        await runCommand(
          service,
          "owner",
          { ...input, id: "second" },
          new AbortController().signal
        )
      ).status
    ).toBe("succeeded")
  })
  it("stops an admitted request even if Stop arrives before its start request", async () => {
    const { runCommand } = await import("../src/terminal/adapters/service")
    const { terminalRequest } = await import("../src/terminal/http")
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
        return run(terminalRequest(f.terminal, request, path, () => {}))
      },
    } as unknown as Fetcher
    const controller = new AbortController()
    const pending = runCommand(service, "owner", input, controller.signal)
    await admitted.promise
    controller.abort()
    await Promise.resolve()
    release.resolve()
    expect((await pending).status).toBe("cancelled")
    expect(f.runtime.execute).not.toHaveBeenCalled()
  })
})

describe("interactive workspace ownership", () => {
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
    f.terminal.session("interactive").save()
    await task.completion
    expect(close).toHaveBeenCalledTimes(1)
    expect(f.repository.get("interactive")).toMatchObject({
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
    expect(f.repository.get("interactive")?.status).toBe("cancelled")
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
      expect(f.repository.get("interactive")?.status).toBe("failed")
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
  expect(f.repository.get("old-session")?.status).toBe("cancelled")
  expect(f.backups.write).not.toHaveBeenCalled()
  const restored = await run(f.terminal.startSession("restored-session"))
  await vi.waitFor(() =>
    expect(f.terminal.state().session?.phase).toBe("ready")
  )
  f.terminal.configure(2, false)
  expect(f.terminal.session("restored-session").live).toBe(true)
  f.terminal.session("restored-session").save()
  await restored.completion
  expect(f.repository.get("restored-session")?.status).toBe("succeeded")
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
    const pending = session.connect(new Request("https://terminal.internal"))
    const rejected = expect(pending).rejects.toThrow("ended")
    if (action === "cancel") await run(f.terminal.cancel("interactive"))
    else session.save()
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
    expect(f.repository.get("interactive")?.status).toBe(
      action === "save" ? "succeeded" : "cancelled"
    )
  }
)
