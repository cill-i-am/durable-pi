import { Cause, Effect, Exit } from "effect"
import { expect, it } from "vitest"

import { bucketLayer } from "../src/memory/adapters/bucket"
import { memoryWake } from "../src/memory/adapters/host"
import { MemorySchedulingError } from "../src/memory/application"
import { BackupFailure, BackupStore } from "../src/memory/backup-store"
import { objectNativeOperation } from "../src/objects/adapters/pi"
import { ObjectFailure } from "../src/objects/contracts"
import { planNativeOperation } from "../src/planning/adapters/pi"
import { PlanFailure } from "../src/planning/contracts"

const cases: readonly {
  name: string
  failure: () => { readonly _tag: string }
  run: (start: () => Promise<void>) => Effect.Effect<unknown, unknown>
}[] = [
  {
    name: "Planning",
    failure: () =>
      new PlanFailure({ code: "conflict", message: "Saved plan changed." }),
    run: planNativeOperation,
  },
  {
    name: "Objects",
    failure: () =>
      new ObjectFailure({ code: "conflict", message: "Saved object changed." }),
    run: objectNativeOperation,
  },
  {
    name: "Memory wake",
    failure: () => new MemorySchedulingError({ operation: "wake" }),
    run: (start) => memoryWake("wake", start),
  },
  {
    name: "Backup",
    failure: () =>
      new BackupFailure({ reason: "conflict", message: "Backup changed." }),
    run: (start) =>
      Effect.flatMap(BackupStore, (bucket) => bucket.put("key", "data")).pipe(
        Effect.provide(
          bucketLayer({
            get: async () => null,
            put: () => start().then(() => ({ etag: "saved" })),
          })
        )
      ),
  },
]

for (const fixture of cases) {
  it(`${fixture.name} keeps its declared rejection after prototype loss`, async () => {
    const failure = fixture.failure()
    Object.setPrototypeOf(failure, Error.prototype)
    const exit = await Effect.runPromiseExit(
      fixture.run(() => Promise.reject(failure))
    )
    expect(Exit.isFailure(exit) && exit.cause.reasons).toMatchObject([
      { _tag: "Fail", error: { ...failure } },
    ])
  })
  it(`${fixture.name} rejects an undeclared local Effect failure as a defect`, async () => {
    const defect = { _tag: "UnexpectedFailure", private: "local diagnostic" }
    const exit = await Effect.runPromiseExit(
      fixture.run(() => Promise.reject(Cause.fail(defect)))
    )
    expect(Exit.isFailure(exit) && exit.cause.reasons).toMatchObject([
      { _tag: "Die", defect },
    ])
  })
  it.each(["defect", "interruption", "compound"])(
    `${fixture.name} retains a native %s Cause`,
    async (mode) => {
      const defect = new Error("private native defect")
      const cause =
        mode === "defect"
          ? Cause.die(defect)
          : mode === "interruption"
            ? Cause.interrupt()
            : Cause.fromReasons([
                Cause.makeFailReason(fixture.failure()),
                Cause.makeDieReason(defect),
                Cause.makeInterruptReason(),
              ])
      const exit = await Effect.runPromiseExit(
        fixture.run(() => Promise.reject(cause))
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.map((reason) => reason._tag)).toEqual(
          cause.reasons.map((reason) => reason._tag)
        )
        if (mode !== "interruption")
          expect(exit.cause.reasons).toContainEqual(
            expect.objectContaining({ _tag: "Die", defect })
          )
      }
    }
  )
  it(`${fixture.name} joins a late native defect after cancellation`, async () => {
    let admitted!: () => void
    let fail!: (cause: unknown) => void
    const entered = new Promise<void>((resolve) => {
      admitted = resolve
    })
    const pending = new Promise<void>((_resolve, reject) => {
      fail = reject
    })
    const controller = new AbortController()
    let settled = false
    const result = Effect.runPromiseExit(
      fixture.run(() => {
        admitted()
        return pending
      }),
      { signal: controller.signal }
    ).then((exit) => {
      settled = true
      return exit
    })
    await entered
    controller.abort()
    await Promise.resolve()
    expect(settled).toBe(false)
    const defect = new Error("private late defect")
    fail(Cause.die(defect))
    const exit = await result
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(exit.cause.reasons).toContainEqual(
        expect.objectContaining({ _tag: "Die", defect })
      )
    }
  })
  it(`${fixture.name} retains synchronous programming errors as defects`, async () => {
    const defect = new Error("native startup bug")
    const exit = await Effect.runPromiseExit(
      fixture.run(() => {
        throw defect
      })
    )
    expect(Exit.isFailure(exit) && exit.cause.reasons).toMatchObject([
      { _tag: "Die", defect },
    ])
  })
  it(`${fixture.name} classifies an opaque transport rejection in its finite error channel`, async () => {
    const exit = await Effect.runPromiseExit(
      fixture.run(() => Promise.reject(new Error("foreign failure")))
    )
    expect(Exit.isFailure(exit) && exit.cause.reasons).toMatchObject([
      { _tag: "Fail", error: { _tag: fixture.failure()._tag } },
    ])
  })
}

it("retains every backup body cleanup reason at the finalizer boundary", async () => {
  const defect = new Error("private backup body cleanup")
  const body = new ReadableStream<Uint8Array>({
    cancel: () =>
      Promise.reject(
        Cause.fromReasons([
          Cause.makeFailReason(
            new BackupFailure({
              reason: "transport",
              message: "Body cleanup failed.",
            })
          ),
          Cause.makeDieReason(defect),
        ])
      ),
  })
  const exit = await Effect.runPromiseExit(
    Effect.flatMap(BackupStore, (bucket) => bucket.get("key")).pipe(
      Effect.provide(
        bucketLayer({
          get: async () => ({ etag: "saved", text: async () => "body", body }),
          put: async () => null,
        })
      )
    )
  )
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect(exit.cause.reasons.map((reason) => reason._tag)).toEqual([
      "Die",
      "Die",
    ])
    expect(exit.cause.reasons).toContainEqual(
      expect.objectContaining({ _tag: "Die", defect })
    )
  }
})
