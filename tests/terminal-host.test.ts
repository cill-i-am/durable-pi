import { Cause, Context, Effect, Exit, Layer, ManagedRuntime } from "effect"
import { expect, it, vi } from "vitest"

vi.mock("@cloudflare/sandbox-v0", () => ({
  Sandbox: class {},
  getSandbox: vi.fn(),
}))

import { nativeOperation } from "../src/shared/interop"
import { TerminalTransportHost } from "../src/terminal/host"
import { LinuxSandbox } from "../src/terminal/worker"

it("rejects video admission after the source migration has frozen", async () => {
  const extract = vi.fn(() =>
    Effect.succeed({
      duration: 1,
      frames: [{ at: 0, jpeg: "synthetic" }],
      captions: "",
      captionsTruncated: false,
    })
  )
  const host = {
    transportHost: new TerminalTransportHost({
      run: Effect.runPromise,
      writable: () => false,
      state: Effect.succeed({ busy: false, session: null }),
      cancel: () => Effect.void,
      recover: Effect.void,
      containerRunning: () => false,
      snapshot: async () => ({ receipt: "unused" }),
    }),
    extractVideo: extract,
    migration: {
      assertWritable: () => {
        throw new Error("frozen")
      },
    },
    env: {},
    terminalRuntime: { runPromise: Effect.runPromise },
    ctx: { waitUntil: vi.fn() },
  }
  const response = await Reflect.apply(LinuxSandbox.prototype.fetch, host, [
    new Request("https://terminal.internal/video", {
      method: "POST",
      body: new Uint8Array([1]),
    }),
  ])
  expect(response.status).toBe(503)
  expect(extract).not.toHaveBeenCalled()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture(now: () => number = Date.now) {
  let terminal = {
    busy: false,
    session: null as { id: string } | null,
    cleanupError: null as string | null,
  }
  const snapshots = vi.fn(async (_name: string, drain: () => Promise<void>) => {
    await drain()
    return { identity: "source-snapshot" }
  })
  const recover = vi.fn()
  const inspected = vi.fn()
  const host = new TerminalTransportHost({
    run: async <T, E>(
      work: Effect.Effect<T, E>,
      options?: { signal?: AbortSignal }
    ) => {
      const exit = await Effect.runPromiseExit(work, options)
      if (Exit.isFailure(exit)) throw exit.cause
      return exit.value
    },
    writable: () => true,
    now,
    state: Effect.sync(() => {
      inspected()
      return terminal
    }),
    cancel: (id: string) =>
      Effect.sync(() => {
        expect(terminal.session?.id).toBe(id)
        terminal = { ...terminal, session: null, busy: false }
      }),
    recover: Effect.sync(() => {
      recover()
    }),
    containerRunning: () => false,
    snapshot: snapshots,
  })
  return {
    host,
    snapshots,
    recover,
    inspected,
    state: (state: typeof terminal) => {
      terminal = state
    },
  }
}

it("retains video occupancy through abort and joined native cleanup", async () => {
  const f = fixture(),
    started = deferred<void>(),
    native = deferred<Response>(),
    cleaning = deferred<void>(),
    cleaned = deferred<void>()
  const abort = new AbortController()
  const result = f.host.video(
    nativeOperation(
      () => {
        started.resolve()
        return native.promise
      },
      (cause) => {
        throw cause
      }
    ).pipe(
      Effect.ensuring(
        Effect.promise(() => {
          cleaning.resolve()
          return cleaned.promise
        })
      )
    ),
    abort.signal
  )
  const observed = result.catch((cause: unknown) => cause)
  await started.promise
  abort.abort()
  expect(f.host.videoBusy).toBe(true)
  native.resolve(new Response("late"))
  await cleaning.promise
  expect(
    (
      await f.host.video(
        Effect.succeed(new Response("second")),
        new AbortController().signal
      )
    ).status
  ).toBe(503)
  let settled = false
  void observed.then(() => {
    settled = true
  })
  await Promise.resolve()
  expect(settled).toBe(false)
  cleaned.resolve()
  const cause = await observed
  expect(Cause.isCause(cause) && Cause.hasInterrupts(cause)).toBe(true)
  expect(f.host.videoBusy).toBe(false)
  expect(
    (
      await f.host.video(
        Effect.succeed(new Response("new")),
        new AbortController().signal
      )
    ).status
  ).toBe(200)
})

it("freezes new video before snapshot work and shares one snapshot until drain joins", async () => {
  const f = fixture(),
    started = deferred<void>(),
    released = deferred<Response>()
  const video = f.host.video(
    nativeOperation(
      () => {
        started.resolve()
        return released.promise
      },
      (cause) => {
        throw cause
      }
    ),
    new AbortController().signal
  )
  await started.promise
  const snapshot = f.host.snapshot("video-source")
  expect(f.host.snapshot("video-source")).toBe(snapshot)
  await expect(f.host.snapshot("different-source")).rejects.toThrow(
    "identity mismatch"
  )
  expect(
    (
      await f.host.video(
        Effect.succeed(new Response("late request")),
        new AbortController().signal
      )
    ).status
  ).toBe(503)
  expect(f.recover).not.toHaveBeenCalled()
  released.resolve(new Response("done"))
  await video
  await expect(snapshot).resolves.toEqual({ identity: "source-snapshot" })
  expect(f.snapshots).toHaveBeenCalledOnce()
  expect(f.recover).toHaveBeenCalledOnce()
  expect(
    (
      await f.host.video(
        Effect.succeed(new Response("after snapshot")),
        new AbortController().signal
      )
    ).status
  ).toBe(503)
})

it("bounds migration drain and permits only an explicit retry after failure", async () => {
  let now = 0
  const f = fixture(() => now)
  f.state({ busy: true, session: null, cleanupError: null })
  const outcome = f.host
    .snapshot("video-source")
    .catch((cause: unknown) => cause)
  await vi.waitFor(() => expect(f.inspected).toHaveBeenCalled())
  now = 60_001
  const cause = await outcome
  expect(Cause.isCause(cause) && Cause.pretty(cause)).toContain(
    "Legacy terminal did not drain"
  )
  expect(f.snapshots).toHaveBeenCalledOnce()
  expect(f.recover).not.toHaveBeenCalled()
  f.state({ busy: false, session: null, cleanupError: null })
  await expect(f.host.snapshot("video-source")).resolves.toEqual({
    identity: "source-snapshot",
  })
  expect(f.snapshots).toHaveBeenCalledTimes(2)
})

it("preserves a compound failure through the request actor and releases only after settlement", async () => {
  const f = fixture()
  const cause = Cause.fromReasons([
    Cause.makeFailReason("native unavailable"),
    Cause.makeDieReason("late cleanup defect"),
  ])
  const failure = await f.host
    .video(Effect.failCause(cause), new AbortController().signal)
    .catch((error: unknown) => error)
  expect(
    Cause.isCause(failure) && failure.reasons.map((reason) => reason._tag)
  ).toEqual(["Fail", "Die"])
  expect(f.host.videoBusy).toBe(false)
})

it("preserves the drain Cause through the production ManagedRuntime promise boundary", async () => {
  class Annotation extends Context.Service<Annotation, string>()(
    "terminal-host-test/annotation"
  ) {}
  const checked = new Error("checked drain failure")
  const defect = new Error("drain cleanup defect")
  const failure = Cause.fromReasons([
    Cause.makeFailReason(checked).annotate(Context.make(Annotation, "checked")),
    Cause.makeDieReason(defect).annotate(Context.make(Annotation, "defect")),
  ])
  const runtime = ManagedRuntime.make(Layer.empty)
  const failures: Cause.Cause<unknown>[] = []
  const host = new TerminalTransportHost({
    run: <T, E>(
      work: Effect.Effect<T, E>,
      options?: { signal?: AbortSignal }
    ) =>
      runtime.runPromise(
        work.pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (Exit.isFailure(exit)) failures.push(exit.cause)
            })
          )
        ),
        options
      ),
    writable: () => true,
    state: Effect.failCause(failure),
    cancel: () => Effect.void,
    recover: Effect.void,
    containerRunning: () => false,
    snapshot: async (_name: string, drain: () => Promise<void>) => {
      await drain()
      return "receipt"
    },
  })
  try {
    await expect(host.snapshot("source")).rejects.toThrow()
    expect(
      failures.at(-1)?.reasons.map((reason) => ({
        tag: reason._tag,
        value:
          reason._tag === "Fail"
            ? reason.error
            : reason._tag === "Die"
              ? reason.defect
              : undefined,
        annotation: reason.annotations.get(Annotation.key),
      }))
    ).toEqual([
      { tag: "Fail", value: checked, annotation: "checked" },
      { tag: "Die", value: defect, annotation: "defect" },
    ])
  } finally {
    await runtime.dispose()
  }
})
