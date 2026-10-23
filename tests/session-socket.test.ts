import { Cause } from "effect"
import { afterEach, expect, it, vi } from "vitest"

import {
  bindSessionSocket,
  sessionSocketResponse,
} from "../src/auth/adapters/session-socket"

class Socket extends EventTarget {
  send = vi.fn()
  close = vi.fn()
  message(data: string | ArrayBuffer) {
    this.dispatchEvent(new MessageEvent("message", { data }))
  }
}
afterEach(() => vi.useRealTimers())
it("closes both directions when a session is revoked and stops forwarding", async () => {
  vi.useFakeTimers()
  const a = new Socket(),
    b = new Socket(),
    authorized = vi.fn().mockResolvedValue(false)
  bindSessionSocket(a, b, authorized)
  a.message("input")
  b.message("output")
  await vi.advanceTimersByTimeAsync(0)
  expect(b.send).toHaveBeenCalledWith("input")
  expect(a.send).toHaveBeenCalledWith("output")
  await vi.advanceTimersByTimeAsync(5000)
  expect(a.close).toHaveBeenCalledWith(1008, "Sign in again")
  expect(b.close).toHaveBeenCalledWith(1008, "Sign in again")
  a.message("blocked")
  expect(b.send).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})
it("fails closed when authorization hangs or fails, and cleans up disconnected clients", async () => {
  vi.useFakeTimers()
  const a = new Socket(),
    b = new Socket()
  bindSessionSocket(a, b, () => new Promise(() => {}))
  await vi.advanceTimersByTimeAsync(15000)
  expect(a.close).toHaveBeenCalledWith(1008, "Sign in again")
  const c = new Socket(),
    d = new Socket()
  bindSessionSocket(c, d, () => Promise.reject(new Error("offline")))
  await vi.advanceTimersByTimeAsync(5000)
  expect(c.close).toHaveBeenCalledWith(1011, "Could not verify session")
  const e = new Socket(),
    f = new Socket()
  bindSessionSocket(e, f, () => Promise.resolve(true))
  e.dispatchEvent(new Event("close"))
  await vi.advanceTimersByTimeAsync(0)
  expect(f.close).toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
it("returns an idempotent disposer that removes timers/listeners and reports every close failure", async () => {
  vi.useFakeTimers()
  const a = new Socket(),
    b = new Socket()
  const first = new Error("First close failed"),
    second = new Error("Second close failed")
  const closed = bindSessionSocket(a, b, async () => true)
  a.close.mockImplementation(() => {
    throw first
  })
  b.close.mockImplementation(() => {
    throw second
  })
  let failure: unknown
  try {
    closed()
    await closed.settled
  } catch (cause) {
    failure = cause
  }
  expect(
    Cause.isCause(failure) &&
      failure.reasons.map((reason) =>
        reason._tag === "Die" ? reason.defect : reason._tag
      )
  ).toEqual([second, first])
  a.message("after teardown")
  expect(b.send).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  closed()
  expect(a.close).toHaveBeenCalledOnce()
  expect(b.close).toHaveBeenCalledOnce()
})
it("cleans up both native endpoints and the timer when upgrade response construction fails", () => {
  vi.useFakeTimers()
  const upstream = Object.assign(new Socket(), {
    accept: vi.fn(),
    binaryType: "arraybuffer" as const,
  })
  const server = Object.assign(new Socket(), {
    accept: vi.fn(),
    binaryType: "arraybuffer" as const,
  })
  vi.stubGlobal(
    "WebSocketPair",
    class {
      0 = new Socket()
      1 = server
    }
  )
  try {
    expect(() =>
      sessionSocketResponse(upstream, async () => true, vi.fn())
    ).toThrow()
    expect(upstream.close).toHaveBeenCalledOnce()
    expect(server.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.unstubAllGlobals()
  }
})

it("a successful held check cannot renew an already expired lease before the timer runs", async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const a = new Socket(),
    b = new Socket()
  let resolve!: (allowed: boolean) => void
  const close = bindSessionSocket(
    a,
    b,
    () =>
      new Promise<boolean>((done) => {
        resolve = done
      })
  )
  try {
    await vi.advanceTimersByTimeAsync(5000)
    vi.setSystemTime(15_001)
    resolve(true)
    await Promise.resolve()
    await Promise.resolve()
    a.message("expired input")
    await vi.advanceTimersByTimeAsync(0)
    expect(b.send).not.toHaveBeenCalled()
    expect(a.close).toHaveBeenCalledWith(1008, "Sign in again")
  } finally {
    close()
    await close.settled
  }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const reasons = (cause: unknown) =>
  Cause.isCause(cause)
    ? cause.reasons.map((reason) =>
        reason._tag === "Die"
          ? reason.defect
          : reason._tag === "Fail"
            ? reason.error
            : reason._tag
      )
    : []

it.each(["close", "expiry"] as const)(
  "joins held auth after %s without allowing its late success to reopen either direction",
  async (end) => {
    vi.useFakeTimers()
    const a = new Socket(),
      b = new Socket(),
      check = deferred<boolean>()
    const authorized = vi.fn(() => check.promise)
    const close = bindSessionSocket(a, b, authorized)
    let settled = false
    void close.settled.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(5000)
    if (end === "close") close()
    else await vi.advanceTimersByTimeAsync(10_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(a.close).toHaveBeenCalledOnce()
    expect(b.close).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    a.message("before native joins")
    check.resolve(true)
    await close.settled
    a.message("late input")
    b.message("late output")
    await vi.advanceTimersByTimeAsync(20_000)
    expect(settled).toBe(true)
    expect(authorized).toHaveBeenCalledOnce()
    expect(a.send).not.toHaveBeenCalled()
    expect(b.send).not.toHaveBeenCalled()
    expect(a.close).toHaveBeenCalledOnce()
  }
)

it("keeps one check in flight and extends a live lease after success", async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const a = new Socket(),
    b = new Socket(),
    check = deferred<boolean>()
  const authorized = vi.fn(() => check.promise)
  const close = bindSessionSocket(a, b, authorized)
  await vi.advanceTimersByTimeAsync(12_000)
  expect(authorized).toHaveBeenCalledOnce()
  a.message("while checking")
  await vi.advanceTimersByTimeAsync(0)
  expect(b.send).toHaveBeenCalledWith("while checking")
  check.resolve(true)
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(3001)
  b.message("renewed")
  await vi.advanceTimersByTimeAsync(0)
  expect(a.send).toHaveBeenCalledWith("renewed")
  expect(authorized).toHaveBeenCalledTimes(2)
  close()
  await close.settled
})

it("denies forwarding at the live deadline even when the expiry callback has not run", async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const a = new Socket(),
    b = new Socket()
  const close = bindSessionSocket(a, b, async () => true)
  await vi.advanceTimersByTimeAsync(0)
  vi.setSystemTime(15_000)
  b.message("expired output")
  await close.settled
  expect(a.send).not.toHaveBeenCalled()
  expect(b.close).toHaveBeenCalledWith(1008, "Sign in again")
})

it.each(["text", "binary"] as const)(
  "enforces the byte cap in both directions for %s frames",
  async (kind) => {
    vi.useFakeTimers()
    for (const direction of ["input", "output"] as const) {
      const a = new Socket(),
        b = new Socket()
      const close = bindSessionSocket(a, b, async () => true)
      const source = direction === "input" ? a : b
      const target = direction === "input" ? b : a
      const full =
        kind === "text" ? "é".repeat(128 * 1024) : new ArrayBuffer(256 * 1024)
      source.message(full)
      await vi.advanceTimersByTimeAsync(0)
      expect(target.send).toHaveBeenCalledWith(full)
      source.message(
        kind === "text" ? `${full}a` : new ArrayBuffer(256 * 1024 + 1)
      )
      await close.settled
      expect(target.send).toHaveBeenCalledOnce()
      expect(a.close).toHaveBeenCalledWith(1009, "Message too large")
      expect(b.close).toHaveBeenCalledWith(1009, "Message too large")
    }
  }
)

it("joins a late compound auth failure and retains every native cleanup failure", async () => {
  vi.useFakeTimers()
  const a = new Socket(),
    b = new Socket(),
    check = deferred<boolean>(),
    failed = vi.fn()
  const closeA = new Error("browser close"),
    closeB = new Error("upstream close"),
    native = new Error("late auth defect")
  const compound = Cause.combine(
    Cause.fail("late auth failure"),
    Cause.combine(Cause.die(native), Cause.interrupt())
  )
  a.close.mockImplementation(() => {
    throw closeA
  })
  b.close.mockImplementation(() => {
    throw closeB
  })
  const close = bindSessionSocket(a, b, () => check.promise, failed)
  await vi.advanceTimersByTimeAsync(5000)
  close()
  await vi.advanceTimersByTimeAsync(0)
  expect(failed).not.toHaveBeenCalled()
  check.reject(compound)
  const failure = await close.settled.catch((cause: unknown) => cause)
  expect(reasons(failure)).toEqual(
    expect.arrayContaining([
      closeA,
      closeB,
      "late auth failure",
      native,
      "Interrupt",
    ])
  )
  expect(reasons(failure)).toHaveLength(5)
  expect(failed).toHaveBeenCalledExactlyOnceWith(failure)
  expect(vi.getTimerCount()).toBe(0)
})

it("cleans partial listener acquisition, attempting every removal and both closes", async () => {
  vi.useFakeTimers()
  const a = new Socket(),
    b = new Socket()
  const acquisition = new Error("listener installation"),
    removal = new Error("listener removal"),
    closeA = new Error("browser close")
  const removeA = vi.spyOn(a, "removeEventListener")
  const removeB = vi.spyOn(b, "removeEventListener").mockImplementation(() => {
    throw removal
  })
  vi.spyOn(b, "addEventListener").mockImplementation(() => {
    throw acquisition
  })
  a.close.mockImplementation(() => {
    throw closeA
  })
  let failure: unknown
  try {
    bindSessionSocket(a, b, async () => true)
  } catch (cause) {
    failure = cause
  }
  expect(reasons(failure)).toEqual(
    expect.arrayContaining([acquisition, removal, closeA])
  )
  expect(removeA).toHaveBeenCalledTimes(3)
  expect(removeB).toHaveBeenCalledOnce()
  expect(a.close).toHaveBeenCalledOnce()
  expect(b.close).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(0)
  expect(vi.getTimerCount()).toBe(0)
  a.message("unowned")
  await vi.advanceTimersByTimeAsync(0)
  expect(b.send).not.toHaveBeenCalled()
})

it("processes close before subsequently queued frames and reports failed sends", async () => {
  vi.useFakeTimers()
  const a = new Socket(),
    b = new Socket()
  const close = bindSessionSocket(a, b, async () => true)
  close()
  a.message("queued after close")
  await close.settled
  expect(b.send).not.toHaveBeenCalled()
  const c = new Socket(),
    d = new Socket(),
    failed = vi.fn(),
    sendFailure = new Error("native send")
  d.send.mockImplementation(() => {
    throw sendFailure
  })
  const end = bindSessionSocket(c, d, async () => true, failed)
  c.message("send failure")
  expect(reasons(await end.settled.catch((cause: unknown) => cause))).toContain(
    sendFailure
  )
  expect(c.close).toHaveBeenCalledOnce()
  expect(d.close).toHaveBeenCalledOnce()
  expect(failed).toHaveBeenCalledOnce()
})

it("rejects malformed native frame data without admitting it to forwarding", async () => {
  vi.useFakeTimers()
  const a = new Socket(),
    b = new Socket()
  const close = bindSessionSocket(a, b, async () => true)
  a.dispatchEvent(new MessageEvent("message", { data: { byteLength: 0 } }))
  await vi.advanceTimersByTimeAsync(0)
  close()
  await close.settled
  expect(a.send).not.toHaveBeenCalled()
  expect(b.send).not.toHaveBeenCalled()
  expect(a.close).toHaveBeenCalledOnce()
  expect(b.close).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it("retains compound native teardown causes without nesting or dropping repeated failures", async () => {
  vi.useFakeTimers()
  const a = new Socket(),
    b = new Socket(),
    same = new Error("same native close defect")
  const compound = Cause.combine(
    Cause.fail("native cleanup checked failure"),
    Cause.die(same)
  )
  a.close.mockImplementation(() => {
    throw compound
  })
  b.close.mockImplementation(() => {
    throw same
  })
  const close = bindSessionSocket(a, b, async () => true)
  close()
  expect(reasons(await close.settled.catch((cause: unknown) => cause))).toEqual(
    [same, "native cleanup checked failure", same]
  )
})

it("scope cleanup retains acquisition and both endpoint failures after a partial accept", () => {
  const acquisition = new Error("upstream accept"),
    serverClose = new Error("server close"),
    upstreamClose = new Error("upstream close")
  const server = Object.assign(new Socket(), {
    accept: vi.fn(),
    binaryType: "arraybuffer" as const,
  })
  const upstream = Object.assign(new Socket(), {
    accept: vi.fn(() => {
      throw acquisition
    }),
    binaryType: "arraybuffer" as const,
  })
  server.close.mockImplementation(() => {
    throw serverClose
  })
  upstream.close.mockImplementation(() => {
    throw upstreamClose
  })
  vi.stubGlobal(
    "WebSocketPair",
    class {
      0 = new Socket()
      1 = server
    }
  )
  try {
    let failure: unknown
    try {
      sessionSocketResponse(upstream, async () => true, vi.fn())
    } catch (cause) {
      failure = cause
    }
    expect(reasons(failure)).toEqual([acquisition, upstreamClose, serverClose])
    expect(server.close).toHaveBeenCalledOnce()
    expect(upstream.close).toHaveBeenCalledOnce()
  } finally {
    vi.unstubAllGlobals()
  }
})
