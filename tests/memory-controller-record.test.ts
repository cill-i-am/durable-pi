import { describe, expect, it, vi } from "vitest"

import { BackupControllerRecord } from "../src/memory/adapters/backup-controller"
import { SummaryControllerRecord } from "../src/memory/adapters/summary-controller"
import {
  decideBackupController,
  initialBackupController,
} from "../src/memory/backup-discovery.machine"
import {
  decideSummaryController,
  initialSummaryController,
} from "../src/memory/summary-discovery.machine"

const recovery = { epoch: "epoch", failedAt: 100, message: "Paused" }
function barrier<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const claim = { attemptId: "attempt", target: "watermark", attempts: 3 }
const cases = [
  {
    name: "summary",
    create: (storage: DurableObjectStorage) =>
      new SummaryControllerRecord(() => storage),
    initial: initialSummaryController(),
    exhausted: decideSummaryController(initialSummaryController(), {
      type: "EXHAUST",
      token: "owner",
      recovery,
    }),
  },
  {
    name: "backup",
    create: (storage: DurableObjectStorage) =>
      new BackupControllerRecord(() => storage),
    initial: initialBackupController(),
    exhausted: decideBackupController(initialBackupController(), {
      type: "EXHAUST",
      token: "owner",
      recovery,
      claim,
    }),
  },
]

describe.each(cases)("$name controller persistence boundary", (f) => {
  it("rejects malformed commands before retaining or writing them", async () => {
    const put = vi.fn()
    const owner = f.create({
      get: async () => f.initial,
      put,
    } as unknown as DurableObjectStorage)
    const future = { ...f.exhausted, workflowVersion: 99 } as never
    await expect(owner.retainExhaustion(future)).rejects.toThrow()
    await expect(owner.commit(future)).rejects.toThrow()
    expect(put).not.toHaveBeenCalled()
    expect(await owner.read()).toEqual(f.initial)
  })
  it("retains exhaustion before a failed write and only releases it after a successful commit", async () => {
    const write = barrier<void>()
    const get = vi.fn(async () => f.initial)
    const put = vi.fn(() => write.promise)
    const owner = f.create({ get, put } as unknown as DurableObjectStorage)
    const pending = owner.retainExhaustion(f.exhausted)
    expect(await owner.read()).toEqual(f.exhausted)
    expect(get).not.toHaveBeenCalled()
    if ("admissionAvailable" in owner)
      expect(owner.admissionAvailable).toBe(false)
    write.reject(new Error("disk unavailable"))
    await expect(pending).rejects.toThrow("disk unavailable")
    expect(await owner.read()).toEqual(f.exhausted)
    await expect(owner.commit(f.initial)).rejects.toThrow("disk unavailable")
    expect(await owner.read()).toEqual(f.exhausted)
    put.mockImplementation(async () => {})
    await owner.commit(f.initial)
    expect(await owner.read()).toEqual(f.initial)
    if ("admissionAvailable" in owner)
      expect(owner.admissionAvailable).toBe(true)
  })

  it("fences a read already in flight when exhaustion is retained", async () => {
    const read = barrier<unknown>()
    const owner = f.create({
      get: () => read.promise,
      put: async () => {
        throw new Error("disk unavailable")
      },
    } as unknown as DurableObjectStorage)
    const pending = owner.read()
    await expect(owner.retainExhaustion(f.exhausted)).rejects.toThrow()
    read.resolve(f.initial)
    expect(await pending).toEqual(f.exhausted)
    expect(await owner.read()).toEqual(f.exhausted)
  })

  it("a late acknowledgement of an earlier write cannot clear retained exhaustion", async () => {
    const write = barrier<void>()
    const put = vi
      .fn(() => write.promise)
      .mockImplementationOnce(() => write.promise)
      .mockRejectedValueOnce(new Error("exhaustion write failed"))
    const owner = f.create({
      get: async () => f.initial,
      put,
    } as unknown as DurableObjectStorage)
    const pending = owner.commit(f.initial)
    await expect(owner.retainExhaustion(f.exhausted)).rejects.toThrow()
    write.resolve()
    await pending
    expect(await owner.read()).toEqual(f.exhausted)
  })

  it("reconstructs persisted exhaustion and rejects unknown versions without resetting storage", async () => {
    let stored: unknown
    const put = vi.fn(async (_key: string, next: unknown) => {
      stored = next
    })
    const storage = {
      get: async () => stored,
      put,
    } as unknown as DurableObjectStorage
    await f.create(storage).retainExhaustion(f.exhausted)
    const restored = f.create(storage)
    expect(await restored.read()).toEqual(f.exhausted)
    if ("admissionAvailable" in restored)
      expect(restored.admissionAvailable).toBe(false)
    stored = { ...f.exhausted, workflowVersion: 99 }
    await expect(f.create(storage).read()).rejects.toThrow()
    expect(put).toHaveBeenCalledTimes(1)
    expect(stored).toEqual({ ...f.exhausted, workflowVersion: 99 })
  })
})

it("backup settlement cannot renew a warm exhausted controller or discard its retained claim", async () => {
  const exhausted = cases[1]!.exhausted
  const put = vi
    .fn<(...args: unknown[]) => Promise<void>>()
    .mockRejectedValueOnce(new Error("disk unavailable"))
    .mockResolvedValue(undefined)
  const owner = new BackupControllerRecord(
    () =>
      ({
        get: async () => initialBackupController(),
        put,
      }) as unknown as DurableObjectStorage
  )
  await expect(owner.retainExhaustion(exhausted)).rejects.toThrow()
  await owner.settle(claim)
  expect(await owner.read()).toEqual(exhausted)
})
