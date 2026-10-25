import { Cause, Effect } from "effect"
import { afterEach, expect, it, vi } from "vitest"

import { upstreamDiagnostic } from "../src/agent/adapters/upstream"

function deferred<A = void>() {
  let resolve!: (value: A) => void
  const promise = new Promise<A>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const turn = () => new Promise<void>((done) => setTimeout(done, 0))

afterEach(() => vi.unstubAllGlobals())

it("starts peer release while the diagnostic reader cancellation is held, and joins both", async () => {
  const cancelling = deferred(),
    held = deferred()
  const reader = {
    read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}),
    cancel: vi.fn(async () => {
      cancelling.resolve()
      await held.promise
    }),
    releaseLock: vi.fn(),
  }
  vi.stubGlobal(
    "IdentityTransformStream",
    class {
      readable = { getReader: () => reader }
      writable = new WritableStream<Uint8Array>()
    }
  )
  const peer = {
    observeUpstream: async () => true,
    releaseUpstream: vi.fn(async () => {}),
  }
  const response = await Effect.runPromise(
    upstreamDiagnostic(
      peer,
      new Request("https://fixture/observe"),
      () => {}
    ).pipe(Effect.scoped)
  )
  let joined = false
  const closing = response.body!.cancel().then(() => {
    joined = true
  })
  await cancelling.promise
  await turn()
  try {
    expect(peer.releaseUpstream).toHaveBeenCalledTimes(1)
    expect(joined).toBe(false)
  } finally {
    held.resolve()
    await closing
  }
  expect(joined).toBe(true)
})

it("holds gateway ownership through cancelled admission and retains all late cleanup reasons", async () => {
  const admission = deferred<boolean>(),
    began = deferred(),
    held = deferred()
  const reader = {
    read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}),
    cancel: vi.fn(async () => {
      await held.promise
      throw Cause.combine(
        Cause.fail("reader checked"),
        Cause.die("reader defect")
      )
    }),
    releaseLock: vi.fn(),
  }
  vi.stubGlobal(
    "IdentityTransformStream",
    class {
      readable = { getReader: () => reader }
      writable = new WritableStream<Uint8Array>()
    }
  )
  const peer = {
    observeUpstream: vi.fn(() => {
      began.resolve()
      return admission.promise
    }),
    releaseUpstream: vi.fn(async () => {
      throw Cause.die("peer defect")
    }),
  }
  const abort = new AbortController()
  const result = Effect.runPromiseExit(
    upstreamDiagnostic(
      peer,
      new Request("https://fixture/observe", { signal: abort.signal }),
      () => {}
    ).pipe(Effect.scoped),
    { signal: abort.signal }
  )
  await began.promise
  abort.abort()
  await turn()
  expect(peer.releaseUpstream).not.toHaveBeenCalled()
  admission.resolve(true)
  await turn()
  expect(peer.releaseUpstream).toHaveBeenCalledTimes(1)
  let joined = false
  void result.then(() => {
    joined = true
  })
  await turn()
  expect(joined).toBe(false)
  held.resolve()
  const exit = await result
  expect(exit._tag).toBe("Failure")
  if (exit._tag === "Failure") {
    const reasons = Cause.pretty(exit.cause)
    expect(reasons).toContain("reader checked")
    expect(reasons).toContain("reader defect")
    expect(reasons).toContain("peer defect")
  }
  expect(reader.releaseLock).toHaveBeenCalledTimes(1)
})

it("starts local cancellation while a held admission waits for that reader", async () => {
  const entered = deferred(),
    admission = deferred<boolean>()
  const reader = {
    read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}),
    cancel: vi.fn(async () => {
      admission.resolve(true)
    }),
    releaseLock: vi.fn(),
  }
  vi.stubGlobal(
    "IdentityTransformStream",
    class {
      readable = { getReader: () => reader }
      writable = new WritableStream<Uint8Array>()
    }
  )
  const peer = {
    observeUpstream: () => {
      entered.resolve()
      return admission.promise
    },
    releaseUpstream: vi.fn(async () => {}),
  }
  const abort = new AbortController()
  const closing = Effect.runPromiseExit(
    upstreamDiagnostic(
      peer,
      new Request("https://fixture/observe", { signal: abort.signal }),
      () => {}
    ).pipe(Effect.scoped),
    { signal: abort.signal }
  )
  await entered.promise
  abort.abort()
  await turn()
  try {
    expect(reader.cancel).toHaveBeenCalledTimes(1)
  } finally {
    admission.resolve(true)
    await closing
  }
  expect(peer.releaseUpstream).toHaveBeenCalledTimes(1)
})

it("retains joined cleanup reasons when releasing the diagnostic reader lock also fails", async () => {
  const reader = {
    read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}),
    cancel: async () => {
      throw Cause.combine(
        Cause.fail("reader checked"),
        Cause.die("reader defect")
      )
    },
    releaseLock: () => {
      throw new Error("reader lock defect")
    },
  }
  vi.stubGlobal(
    "IdentityTransformStream",
    class {
      readable = { getReader: () => reader }
      writable = new WritableStream<Uint8Array>()
    }
  )
  const peer = {
    observeUpstream: async () => true,
    releaseUpstream: async () => {
      throw Cause.die("peer defect")
    },
  }
  const response = await Effect.runPromise(
    upstreamDiagnostic(
      peer,
      new Request("https://fixture/observe"),
      () => {}
    ).pipe(Effect.scoped)
  )
  const cause: unknown = await response
    .body!.cancel()
    .catch((cause: unknown) => cause)
  expect(Cause.isCause(cause)).toBe(true)
  if (Cause.isCause(cause))
    for (const reason of [
      "reader checked",
      "reader defect",
      "peer defect",
      "reader lock defect",
    ])
      expect(Cause.pretty(cause)).toContain(reason)
})
