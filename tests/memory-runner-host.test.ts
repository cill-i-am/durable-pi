import { AsyncLocalStorage } from "node:async_hooks"

import { Cause, Context, Effect } from "effect"
import { expect, it } from "vitest"
import { initialTransition, transition } from "xstate"

import { MaintenanceRunnerHost } from "../src/memory/adapters/runner-host"
import { maintenanceRunnerHostMachine } from "../src/memory/runner-host.machine"

function gate<A>() {
  let resolve!: (value: A) => void, reject!: (error: unknown) => void
  const promise = new Promise<A>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
it("coalesces cold restoration, shares its failure, and retries only on the next call", async () => {
  const entered = gate<void>(),
    held = gate<void>()
  let calls = 0
  const host = new MaintenanceRunnerHost(async () => {
    calls++
    if (calls === 1) {
      entered.resolve()
      await held.promise
    }
  })
  const first = host.restore().catch((error: unknown) => error)
  await entered.promise
  const second = host.restore().catch((error: unknown) => error)
  const failure = new Error("native restore failed")
  held.reject(failure)
  const values = await Promise.all([first, second])
  for (const value of values) {
    expect(Cause.isCause(value)).toBe(true)
    if (!Cause.isCause(value)) throw new Error("Expected native Cause")
    expect(
      value.reasons.some(
        (reason) => reason._tag === "Fail" && reason.error === failure
      )
    ).toBe(true)
  }
  expect(calls).toBe(1)
  await host.restore()
  await host.restore()
  expect(calls).toBe(2)
  await host.dispose(async () => {})
  await host.restore()
  expect(calls).toBe(2)
})
class NativeTrace extends Context.Service<NativeTrace, string>()(
  "memory-runner/NativeTrace"
) {}
it.each([false, true])(
  "joins held restoration and preserves its entire native Cause (defect %s)",
  async (defect) => {
    const entered = gate<void>(),
      held = gate<void>(),
      closingEntered = gate<void>()
    const checked = new Error("checked restore"),
      died = new Error("native defect")
    const annotation = Context.make(NativeTrace, "original")
    const failure = Cause.fromReasons([
      Cause.makeFailReason(checked).annotate(annotation),
      ...(defect ? [Cause.makeDieReason(died).annotate(annotation)] : []),
      Cause.makeInterruptReason(55119).annotate(annotation),
    ])
    const host = new MaintenanceRunnerHost(async () => {
      entered.resolve()
      await held.promise
    })
    const restoring = host.restore().catch((error: unknown) => error)
    await entered.promise
    let disposed = false
    const closing = host
      .dispose(async () => {
        closingEntered.resolve()
      })
      .catch((error: unknown) => error)
      .finally(() => {
        disposed = true
      })
    await closingEntered.promise
    expect(host.stopped).toBe(true)
    expect(disposed).toBe(false)
    await host.restore()
    held.reject(failure)
    for (const value of await Promise.all([restoring, closing])) {
      expect(Cause.isCause(value)).toBe(true)
      if (!Cause.isCause(value)) throw new Error("Expected full native Cause")
      expect(
        value.reasons.some(
          (reason) =>
            reason._tag === "Fail" &&
            reason.error === checked &&
            reason.annotations.get(NativeTrace.key) === "original"
        )
      ).toBe(true)
      expect(
        value.reasons.some(
          (reason) =>
            reason._tag === "Interrupt" &&
            reason.fiberId === 55119 &&
            reason.annotations.get(NativeTrace.key) === "original"
        )
      ).toBe(true)
      expect(
        value.reasons.some(
          (reason) =>
            reason._tag === "Die" &&
            reason.defect === died &&
            reason.annotations.get(NativeTrace.key) === "original"
        )
      ).toBe(defect)
    }
  }
)
it("constructs restoration in the actual startup caller's native context", async () => {
  const context = new AsyncLocalStorage<string>()
  let observed: string | undefined
  const host = new MaintenanceRunnerHost(async () => {
    observed = context.getStore()
  })
  await context.run("startup-owner", () => host.restore())
  expect(observed).toBe("startup-owner")
  await host.dispose(async () => {})
})
it("joins native owner cleanup once and retains its failure", async () => {
  const host = new MaintenanceRunnerHost(async () => {})
  const entered = gate<void>(),
    held = gate<void>(),
    failure = Cause.fail("native close failed")
  let calls = 0
  const first = host
    .dispose(async () => {
      calls++
      entered.resolve()
      await held.promise
    })
    .catch((error: unknown) => error)
  await entered.promise
  const second = host
    .dispose(async () => {
      calls++
    })
    .catch((error: unknown) => error)
  held.reject(failure)
  for (const result of await Promise.all([first, second])) {
    expect(Cause.isCause(result)).toBe(true)
    expect(String(result)).toContain("native close failed")
  }
  expect(calls).toBe(1)
})
it("rejects malformed restoration events with the official runtime validator", () => {
  const machine = maintenanceRunnerHostMachine(() => Effect.void)
  const [initial] = initialTransition(machine)
  const [state, effects] = transition(machine, initial, {
    type: "RESTORE",
    reply: null,
  } as never)
  expect(state.value).toEqual(initial.value)
  expect(
    effects.some(
      (effect) =>
        effect.kind === "builtin" &&
        effect.type === "@xstate.deadLetter" &&
        effect.reason === "invalidEvent"
    )
  ).toBe(true)
})
