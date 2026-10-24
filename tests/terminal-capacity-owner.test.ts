import { Cause, Context } from "effect"
import { afterEach, expect, it, vi } from "vitest"

import { NativeContainerOwner } from "../src/terminal/adapters/capacity"

const identity = "c".repeat(64)
const owners: NativeContainerOwner[] = []
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.dispose()
})
function barrier() {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}
function fixture() {
  let token: number | undefined
  let fence = 0
  const container = {
    images: { TerminalImage: "synthetic" },
    start: vi.fn(),
    setInactivityTimeout: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
    running: false,
  }
  const capacity = {
    acquire: vi.fn(async () => ({ owner: identity, epoch: 7, issuedAt: 0 })),
    release: vi.fn(async () => true),
  }
  const owner = new NativeContainerOwner(identity, container, capacity, {
    token: () => token,
    setToken: (value) => {
      token = value
    },
    fence: () => fence,
    setFence: (value) => {
      fence = value
    },
  })
  owners.push(owner)
  return { owner, container, capacity, token: () => token }
}
it("joins the admitted native start before one teardown answers concurrent closes", async () => {
  const f = fixture(),
    entered = barrier(),
    resume = barrier()
  f.container.setInactivityTimeout.mockImplementationOnce(async () => {
    entered.release()
    await resume.wait
  })
  const starting = f.owner.start()
  await entered.wait
  const first = f.owner.close(),
    second = f.owner.close()
  await expect(f.owner.start()).rejects.toThrow("busy")
  expect(f.container.destroy).not.toHaveBeenCalled()
  expect(f.capacity.release).not.toHaveBeenCalled()
  resume.release()
  await Promise.all([starting, first, second])
  expect(f.container.destroy).toHaveBeenCalledTimes(1)
  expect(f.capacity.release).toHaveBeenCalledExactlyOnceWith(identity, 7)
  expect(f.token()).toBeUndefined()
})
it("keeps a failed teardown capability and blocks starts until cleanup succeeds", async () => {
  const f = fixture()
  await f.owner.start()
  f.container.destroy.mockRejectedValueOnce(new Error("unconfirmed teardown"))
  await expect(f.owner.close()).rejects.toThrow("unconfirmed teardown")
  expect(f.token()).toBe(7)
  expect(f.capacity.release).not.toHaveBeenCalled()
  await expect(f.owner.start()).rejects.toThrow("busy")
  expect(await f.owner.retireIdle(7)).toBe(false)
  await f.owner.close()
  expect(f.token()).toBeUndefined()
  await f.owner.start()
  expect(f.container.start).toHaveBeenCalledTimes(2)
})
it("joins retirement before checking the late acquisition fence", async () => {
  const f = fixture(),
    entered = barrier(),
    resume = barrier()
  f.container.destroy.mockImplementationOnce(async () => {
    entered.release()
    await resume.wait
  })
  const retiring = f.owner.retireIdle(7)
  await entered.wait
  const starting = f.owner.start().then(
    () => "started",
    () => "fenced"
  )
  // A concurrent retirement request is denied without another destroy.
  expect(await f.owner.retireIdle(8)).toBe(false)
  expect(f.container.start).not.toHaveBeenCalled()
  resume.release()
  expect(await retiring).toBe(true)
  expect(await starting).toBe("fenced")
  expect(f.container.start).not.toHaveBeenCalled()
  await f.owner.close()
  expect(f.capacity.release).toHaveBeenCalledWith(identity, 7)
})
it.each([false, true])(
  "retains full failed native cleanup including annotations (defect %s)",
  async (defect) => {
    const f = fixture()
    await f.owner.start()
    const checked = new Error("native cleanup failed")
    let cause = Cause.combine(Cause.fail(checked), Cause.interrupt(94302))
    if (defect) cause = Cause.combine(cause, Cause.die("native cleanup defect"))
    cause = Cause.annotate(
      cause,
      Context.make(Context.Service<string>("terminal-cleanup"), "held")
    )
    f.container.destroy.mockRejectedValueOnce(cause)
    const result = await f.owner.close().then(
      () => undefined,
      (error: unknown) => error
    )
    expect(Cause.isCause(result)).toBe(true)
    if (!Cause.isCause(result)) throw new Error("Missing structured Cause")
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ _tag: "Fail", error: checked }),
        expect.objectContaining({ _tag: "Interrupt", fiberId: 94302 }),
      ])
    )
    if (defect)
      expect(result.reasons).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            _tag: "Die",
            defect: "native cleanup defect",
          }),
        ])
      )
    expect(
      result.reasons.every(
        (reason) => reason.annotations.get("terminal-cleanup") === "held"
      )
    ).toBe(true)
    expect(f.token()).toBe(7)
    expect(f.capacity.release).not.toHaveBeenCalled()
    await f.owner.close()
  }
)
it("joins an in-progress start when its lifetime is disposed and denies later calls", async () => {
  const f = fixture(),
    entered = barrier(),
    resume = barrier()
  f.container.setInactivityTimeout.mockImplementationOnce(async () => {
    entered.release()
    await resume.wait
  })
  const starting = f.owner.start()
  await entered.wait
  let closed = false
  const closing = f.owner.dispose().then(() => {
    closed = true
  })
  await expect(f.owner.start()).rejects.toThrow("busy")
  expect(closed).toBe(false)
  expect(f.container.destroy).not.toHaveBeenCalled()
  resume.release()
  await Promise.all([starting, closing])
  expect(f.capacity.release).toHaveBeenCalledExactlyOnceWith(identity, 7)
  await expect(f.owner.start()).rejects.toThrow("closed")
  await expect(f.owner.retireIdle(7)).rejects.toThrow("closed")
})
