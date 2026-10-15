import { expect, it, vi } from "vitest"
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect"
import type { Harness } from "@earendil-works/pi-durable"
import { piMailbox } from "../src/communication/adapters/pi"
import { TaskExecution } from "../src/communication/execution"
import { sqliteMailbox } from "../src/communication/adapters/sqlite"
import { database } from "./database"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
it("joins noncooperative native Pi acquisition before Communication's Layer is released", async () => {
  const started = deferred(),
    settled = deferred()
  const snapshot = vi.fn()
  const harness = { snapshot } as unknown as Harness
  const service = piMailbox(
    async () => {
      started.resolve()
      await settled.promise
      return harness
    },
    { submit: async () => {}, abort: async () => {} },
    Effect.runSync(sqliteMailbox(database()).initialize),
    {
      permitted: () => Effect.succeed(true),
      authenticate: () => Effect.void,
      deliver: () => Effect.die("Unexpected delivery"),
    },
    () => Effect.die("Unexpected settings lookup")
  )
  let closed = false,
    ended = false
  const runtime = ManagedRuntime.make(
    Layer.effect(
      TaskExecution,
      Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed = true
        })
      ).pipe(Effect.as(service))
    )
  )
  const pending = runtime
    .runPromiseExit(service.inspect("task"))
    .then((exit) => {
      ended = true
      return exit
    })
  await started.promise
  const disposing = runtime.dispose()
  expect(closed).toBe(false)
  expect(ended).toBe(false)
  settled.resolve()
  const exit = await pending
  await disposing
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  expect(snapshot).not.toHaveBeenCalled()
  expect(closed).toBe(true)
})
