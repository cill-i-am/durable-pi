import { expect, it } from "vitest"
import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
} from "effect"
import { database } from "./database"
import { MemoryRepository } from "../src/memory/repository"
import { makeSqliteMemory } from "../src/memory/adapters/sqlite"
import { exportResponse } from "../src/memory/adapters/http"
import { bucketLayer, type BackupBucket } from "../src/memory/adapters/bucket"
import { BackupStore } from "../src/memory/backup-store"
import { MemoryStorageError } from "../src/memory/domain"

function gate<T = void>() {
  let release!: (value: T) => void
  const waiting = new Promise<T>((resolve) => {
    release = resolve
  })
  return { waiting, release }
}
function retained(events: string[]) {
  return Layer.effectDiscard(
    Effect.addFinalizer(() =>
      Effect.sync(() => {
        events.push("layer.closed")
      })
    )
  )
}
function memory() {
  const repository = Effect.runSync(makeSqliteMemory(database()))
  Effect.runSync(repository.append("source", "user", "Synthetic source"))
  return repository
}

it("actor disposal joins export cleanup and retains invocation Context after returning the response", async () => {
  class Request extends Context.Service<Request, string>()(
    "test/ExportRequest"
  ) {}
  const repository = memory(),
    events: string[] = [],
    entered = gate(),
    cleaning = gate(),
    release = gate(),
    seen: string[] = []
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(MemoryRepository, {
        ...repository,
        archivePage: () =>
          Effect.serviceOption(Request).pipe(
            Effect.tap((value) =>
              Effect.sync(() =>
                seen.push(Option.getOrElse(value, () => "missing"))
              )
            ),
            Effect.andThen(Effect.sync(() => entered.release())),
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.promise(async () => {
                cleaning.release()
                await release.waiting
                events.push("export.closed")
              })
            )
          ),
      }),
      retained(events)
    )
  )
  let closing: Promise<void> | undefined
  try {
    const response = await runtime.runPromise(
      exportResponse(false, {
        run: (program, options) => runtime.runPromiseExit(program, options),
      }).pipe(Effect.provideService(Request, "this invocation"))
    )
    const reader = response.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    const next = reader.read()
    await entered.waiting
    closing = runtime.dispose()
    await cleaning.waiting
    expect(events).toEqual([])
    expect(seen).toEqual(["this invocation"])
    release.release()
    await closing
    expect(await next).toMatchObject({ done: true })
    expect(events).toEqual(["export.closed", "layer.closed"])
  } finally {
    release.release()
    await runtime.dispose()
    await closing
  }
})

it("request abort stops body production and joins cleanup without publishing an archive footer", async () => {
  const repository = memory(),
    entered = gate(),
    signal = new AbortController()
  let finalized = false
  const response = await Effect.runPromise(
    exportResponse(false, { signal: signal.signal }).pipe(
      Effect.provideService(MemoryRepository, {
        ...repository,
        archivePage: () =>
          Effect.sync(() => entered.release()).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                finalized = true
              })
            )
          ),
      })
    )
  )
  const pending = response.text()
  await entered.waiting
  signal.abort()
  const output = await pending
  expect(finalized).toBe(true)
  expect(JSON.parse(output.trim()).type).toBe("header")
})

it("an unconsumed export bounds reads instead of draining the archive", async () => {
  const repository = memory(),
    firstPage = gate()
  for (let n = 0; n < 100; n++)
    Effect.runSync(repository.append(`s${n}`, "user", `Synthetic ${n}`))
  let pages = 0
  const response = await Effect.runPromise(
    exportResponse().pipe(
      Effect.provideService(MemoryRepository, {
        ...repository,
        archivePage: (...args) =>
          Effect.sync(() => {
            pages++
            firstPage.release()
          }).pipe(Effect.andThen(repository.archivePage(...args))),
      })
    )
  )
  await firstPage.waiting
  await response.body!.cancel()
  expect(pages).toBe(1)
})

it("archive source failures reach the body as safe errors and retain the original Exit for telemetry", async () => {
  const repository = memory(),
    exits: Exit.Exit<void, unknown>[] = []
  const response = await Effect.runPromise(
    exportResponse(false, {
      run: (program, options) =>
        Effect.runPromiseExit(program, options).then((exit) => {
          exits.push(exit)
          return exit
        }),
    }).pipe(
      Effect.provideService(MemoryRepository, {
        ...repository,
        archivePage: () =>
          Effect.fail(
            new MemoryStorageError({ operation: "private database details" })
          ),
      })
    )
  )
  await expect(response.text()).rejects.toThrow(
    "Memory export could not be completed."
  )
  expect(exits).toHaveLength(1)
  expect(exits[0]).toMatchObject({ _tag: "Failure" })
})

it("late bucket acquisition releases its unread body before actor Layers close", async () => {
  const events: string[] = [],
    entered = gate(),
    acquired = gate<Awaited<ReturnType<BackupBucket["get"]>>>(),
    cleaning = gate(),
    release = gate()
  let reads = 0
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      bucketLayer({
        get: () => {
          entered.release()
          return acquired.waiting
        },
        put: async () => ({ etag: "synthetic" }),
      }),
      retained(events)
    )
  )
  let closing: Promise<void> | undefined
  try {
    const pending = runtime.runPromiseExit(
      Effect.flatMap(BackupStore, (store) => store.get("synthetic"))
    )
    await entered.waiting
    closing = runtime.dispose()
    acquired.release({
      etag: "synthetic",
      text: async () => {
        reads++
        return "body"
      },
      body: new ReadableStream<Uint8Array>({
        async cancel() {
          cleaning.release()
          await release.waiting
          events.push("body.closed")
        },
      }),
    })
    await cleaning.waiting
    expect(reads).toBe(0)
    expect(events).toEqual([])
    release.release()
    await closing
    const exit = await pending
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(events).toEqual(["body.closed", "layer.closed"])
  } finally {
    release.release()
    acquired.release(null)
    await runtime.dispose()
    await closing
  }
})

it("interrupted bucket body reads settle before actor Layers close", async () => {
  const events: string[] = [],
    entered = gate(),
    release = gate<string>()
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      bucketLayer({
        get: async () => ({
          etag: "synthetic",
          text: () => {
            entered.release()
            return release.waiting.then((text) => {
              events.push("body.settled")
              return text
            })
          },
        }),
        put: async () => ({ etag: "synthetic" }),
      }),
      retained(events)
    )
  )
  try {
    const pending = runtime.runPromiseExit(
      Effect.flatMap(BackupStore, (store) => store.get("synthetic"))
    )
    await entered.waiting
    const closing = runtime.dispose()
    expect(events).toEqual([])
    release.release("late body")
    await closing
    const exit = await pending
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(events).toEqual(["body.settled", "layer.closed"])
  } finally {
    release.release("cleanup")
    await runtime.dispose()
  }
})

it("actor shutdown joins a noncooperative bucket write without running the following publication step", async () => {
  const events: string[] = [],
    entered = gate(),
    release = gate()
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      bucketLayer({
        get: async () => null,
        put: async () => {
          entered.release()
          await release.waiting
          events.push("remote.write")
          return { etag: "synthetic" }
        },
      }),
      retained(events)
    )
  )
  try {
    const pending = runtime.runPromiseExit(
      Effect.flatMap(BackupStore, (store) =>
        store.put("synthetic", "data")
      ).pipe(Effect.andThen(Effect.sync(() => events.push("publication"))))
    )
    await entered.waiting
    const closing = runtime.dispose()
    expect(events).toEqual([])
    release.release()
    await closing
    const exit = await pending
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(events).toEqual(["remote.write", "layer.closed"])
  } finally {
    release.release()
    await runtime.dispose()
  }
})

it("bucket failures are safe and typed while synchronous callback defects remain defects", async () => {
  const defect = new Error("private programming detail")
  const rejected = await Effect.runPromise(
    Effect.flatMap(BackupStore, (store) => store.put("synthetic", "data")).pipe(
      Effect.provide(
        bucketLayer({
          get: async () => null,
          put: () => Promise.reject(defect),
        })
      ),
      Effect.result
    )
  )
  expect(rejected).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "BackupFailure",
      reason: "transport",
      message: "Backup write failed",
    },
  })
  const thrown = await Effect.runPromiseExit(
    Effect.flatMap(BackupStore, (store) => store.put("synthetic", "data")).pipe(
      Effect.provide(
        bucketLayer({
          get: async () => null,
          put: () => {
            throw defect
          },
        })
      )
    )
  )
  expect(Exit.isFailure(thrown) && Cause.hasDies(thrown.cause)).toBe(true)
  expect(Exit.isFailure(thrown) && Cause.hasFails(thrown.cause)).toBe(false)
  const malformed = await Effect.runPromiseExit(
    Effect.flatMap(BackupStore, (store) => store.put("synthetic", "data")).pipe(
      Effect.provide(
        bucketLayer({
          get: async () => null,
          put: () => Promise.reject(new SyntaxError("private codec detail")),
        })
      )
    )
  )
  expect(Exit.isFailure(malformed) && Cause.hasDies(malformed.cause)).toBe(true)
  expect(Exit.isFailure(malformed) && Cause.hasFails(malformed.cause)).toBe(
    false
  )
})
