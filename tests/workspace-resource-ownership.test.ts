import { afterEach, expect, it } from "vitest"
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
import { makeWorkspace } from "../src/workspace/service"
import { SqliteWorkspace } from "../src/workspace/adapters/sqlite"
import {
  r2WorkspaceAssets,
  type AssetBucket,
} from "../src/workspace/adapters/r2"
import { filesRequest } from "../src/workspace/adapters/http"
import { Workspace } from "../src/workspace/workspace"
import { WorkspaceUnavailable, type FileError } from "../src/workspace/files"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})
function gate() {
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  return { waiting, release }
}
const file = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "private.md",
  mime: "text/plain",
  bytes: new TextEncoder().encode("Private file"),
}
function fixture(
  get: AssetBucket["get"],
  inspect: () => Effect.Effect<void> = () => Effect.void
) {
  const events: string[] = []
  const assets = r2WorkspaceAssets(
    { get, put: async () => {} },
    "private-owner"
  )
  const workspace = makeWorkspace(
    new SqliteWorkspace(database()),
    {
      ...assets,
      open: (asset) => inspect().pipe(Effect.andThen(assets.open(asset))),
    },
    () => true,
    () => Effect.fail(new WorkspaceUnavailable()),
    () => Effect.fail(new WorkspaceUnavailable())
  )
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(Workspace, workspace),
      Layer.effectDiscard(
        Effect.addFinalizer(() =>
          Effect.sync(() => {
            events.push("layer.closed")
          })
        )
      )
    )
  )
  cleanups.push(() => runtime.dispose())
  const request = (signal?: AbortSignal) =>
    new Request(`https://app.example.com/files/${file.id}/content`, { signal })
  const path = `files/${file.id}/content`
  const serve = (input = request()) =>
    filesRequest(input, path, (program, options) =>
      runtime.runPromiseExit(program, options)
    )
  return { runtime, workspace, events, serve, request }
}

it("actor disposal joins a held download and retains invocation Context until body cleanup completes", async () => {
  class Invocation extends Context.Service<Invocation, string>()(
    "FileInvocation"
  ) {}
  const entered = gate(),
    cleaning = gate(),
    release = gate(),
    seen: string[] = []
  let pulls = 0
  const native = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(file.bytes)
        else {
          entered.release()
          return new Promise<void>(() => {})
        }
      },
      async cancel() {
        cleaning.release()
        await release.waiting
      },
    },
    { highWaterMark: 0 }
  )
  const f = fixture(
    async () => ({
      body: native,
      arrayBuffer: async () => file.bytes.slice().buffer,
    }),
    () =>
      Effect.serviceOption(Invocation).pipe(
        Effect.map((value) => {
          seen.push(Option.getOrElse(value, () => "missing"))
        })
      )
  )
  await f.runtime.runPromise(f.workspace.upload(file))
  const response = await f.runtime.runPromise(
    f.serve().pipe(Effect.provideService(Invocation, "this request"))
  )
  const reader = response.body!.getReader()
  expect((await reader.read()).value).toEqual(file.bytes)
  const pending = reader.read()
  await entered.waiting
  const disposing = f.runtime.dispose()
  await cleaning.waiting
  expect(f.events).toEqual([])
  expect(seen).toEqual(["this request"])
  release.release()
  await disposing
  expect(await pending).toMatchObject({ done: true })
  expect(native.locked).toBe(false)
  expect(f.events).toEqual(["layer.closed"])
})

it("consumer cancellation joins native release and does not prefetch an unbounded download", async () => {
  const cleaning = gate(),
    release = gate()
  let pulls = 0,
    cancellations = 0
  const native = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls++
        controller.enqueue(file.bytes)
      },
      async cancel() {
        cancellations++
        cleaning.release()
        await release.waiting
      },
    },
    { highWaterMark: 0 }
  )
  const f = fixture(async () => ({
    body: native,
    arrayBuffer: async () => file.bytes.slice().buffer,
  }))
  await f.runtime.runPromise(f.workspace.upload(file))
  const response = await f.runtime.runPromise(f.serve())
  expect(pulls).toBeLessThanOrEqual(1)
  let cancelled = false
  const stopping = response.body!.cancel().then(() => {
    cancelled = true
  })
  await cleaning.waiting
  expect(cancelled).toBe(false)
  release.release()
  await stopping
  expect(cancellations).toBe(1)
  expect(native.locked).toBe(false)
})

it("request abort before headers releases a late acquired body before the request ends", async () => {
  const entered = gate(),
    acquisition = gate(),
    cleaning = gate(),
    release = gate()
  const native = new ReadableStream<Uint8Array>(
    {
      async cancel() {
        cleaning.release()
        await release.waiting
      },
    },
    { highWaterMark: 0 }
  )
  const f = fixture(async () => {
    entered.release()
    await acquisition.waiting
    return { body: native, arrayBuffer: async () => file.bytes.slice().buffer }
  })
  await f.runtime.runPromise(f.workspace.upload(file))
  const controller = new AbortController(),
    request = f.request(controller.signal)
  let finished = false
  const pending = f.runtime
    .runPromiseExit(f.serve(request), { signal: request.signal })
    .then((exit) => {
      finished = true
      return exit
    })
  await entered.waiting
  controller.abort()
  acquisition.release()
  await cleaning.waiting
  expect(finished).toBe(false)
  release.release()
  const exit = await pending
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  expect(native.locked).toBe(false)
})

it("preserves the pre-header unavailable status and safe errors after a body fails", async () => {
  const missing = fixture(async () => null)
  await missing.runtime.runPromise(missing.workspace.upload(file))
  expect((await missing.runtime.runPromise(missing.serve())).status).toBe(503)
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const native = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value
      },
    },
    { highWaterMark: 0 }
  )
  const f = fixture(async () => ({
    body: native,
    arrayBuffer: async () => file.bytes.slice().buffer,
  }))
  await f.runtime.runPromise(f.workspace.upload(file))
  const response = await f.runtime.runPromise(f.serve())
  expect(response.status).toBe(200)
  controller.error(new Error("Private bucket failure"))
  await expect(response.text()).rejects.toThrow("The file could not be read.")
  expect(native.locked).toBe(false)
})

it("reports failed cleanup as a defect while returning no private release details to the consumer", async () => {
  const native = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(file.bytes)
      },
      cancel() {
        throw new Error("Private cleanup failure")
      },
    },
    { highWaterMark: 0 }
  )
  const f = fixture(async () => ({
    body: native,
    arrayBuffer: async () => file.bytes.slice().buffer,
  }))
  await f.runtime.runPromise(f.workspace.upload(file))
  let outcome: Exit.Exit<void, FileError> | undefined
  const request = f.request()
  const response = await f.runtime.runPromise(
    filesRequest(
      request,
      `files/${file.id}/content`,
      async (program, options) => {
        const exit = await f.runtime.runPromiseExit(program, options)
        outcome = exit
        return exit
      }
    )
  )
  await expect(response.body!.cancel()).rejects.toThrow(
    "File download cleanup failed."
  )
  expect(
    outcome && Exit.isFailure(outcome) && Cause.hasDies(outcome.cause)
  ).toBe(true)
  expect(native.locked).toBe(false)
})
