import { expect, it } from "vitest"
import { Cause, Effect, Exit, Layer } from "effect"
import { documentService } from "../src/workspace/adapters/document-service"
import { videoService } from "../src/workspace/adapters/video-service"
import { filesRequest } from "../src/workspace/adapters/http"
import { Workspace } from "../src/workspace/workspace"
import { makeWorkspace } from "../src/workspace/service"
import { SqliteWorkspace } from "../src/workspace/adapters/sqlite"
import { r2WorkspaceAssets } from "../src/workspace/adapters/r2"
import type { DocumentUnreadable } from "../src/workspace/documents"
import type { VideoUnreadable } from "../src/workspace/video"
import { WorkspaceUnavailable } from "../src/workspace/files"
import { database } from "./database"

function gate() {
  let release!: () => void
  const waiting = new Promise<void>((done) => {
    release = done
  })
  return { waiting, release }
}
const services: ReadonlyArray<{
  name: string
  extract: (
    fetch: (request: Request) => Promise<Response>
  ) => (
    bytes: Uint8Array
  ) => Effect.Effect<
    void,
    DocumentUnreadable | VideoUnreadable | WorkspaceUnavailable
  >
}> = [
  {
    name: "document",
    extract: (fetch: (request: Request) => Promise<Response>) => (bytes) =>
      documentService({ fetch })(bytes).pipe(Effect.asVoid),
  },
  {
    name: "video",
    extract: (fetch: (request: Request) => Promise<Response>) => (bytes) =>
      videoService({ fetch }, "owner")(bytes).pipe(Effect.asVoid),
  },
]

it.each(services)(
  "$name cancellation joins a late response and its unread body",
  async ({ extract }) => {
    const entered = gate(),
      fetched = gate(),
      cleaning = gate(),
      close = gate(),
      abort = new AbortController()
    let signal: AbortSignal | undefined,
      cancellations = 0,
      settled = false
    const body = new ReadableStream<Uint8Array>({
      async cancel() {
        cancellations++
        cleaning.release()
        await close.waiting
      },
    })
    const work = Effect.runPromiseExit(
      extract(async (request) => {
        signal = request.signal
        entered.release()
        await fetched.waiting
        return new Response(body)
      })(new Uint8Array()),
      { signal: abort.signal }
    ).then((exit) => {
      settled = true
      return exit
    })
    await entered.waiting
    abort.abort()
    await expect.poll(() => signal?.aborted).toBe(true)
    expect(settled).toBe(false)
    fetched.release()
    await cleaning.waiting
    expect(settled).toBe(false)
    close.release()
    const exit = await work
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(cancellations).toBe(1)
    expect(body.locked).toBe(false)
  }
)

it.each(services)(
  "$name body cancellation joins reader cleanup before releasing the lock",
  async ({ extract }) => {
    const reading = gate(),
      cleaning = gate(),
      close = gate(),
      abort = new AbortController()
    let settled = false,
      cancellations = 0
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          reading.release()
          return new Promise<void>(() => {})
        },
        async cancel() {
          cancellations++
          cleaning.release()
          await close.waiting
        },
      },
      { highWaterMark: 0 }
    )
    const work = Effect.runPromiseExit(
      extract(async () => new Response(body))(new Uint8Array()),
      { signal: abort.signal }
    ).then((exit) => {
      settled = true
      return exit
    })
    await reading.waiting
    abort.abort()
    await cleaning.waiting
    expect(settled).toBe(false)
    expect(body.locked).toBe(true)
    close.release()
    const exit = await work
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(body.locked).toBe(false)
    expect(cancellations).toBe(1)
  }
)

it.each(services)(
  "$name closes unread error responses and preserves malformed protocol/cleanup defects",
  async ({ extract }) => {
    let closed = 0
    const fail = await Effect.runPromiseExit(
      extract(
        async () =>
          new Response(
            new ReadableStream({
              cancel() {
                closed++
              },
            }),
            { status: 503 }
          )
      )(new Uint8Array())
    )
    expect(fail).toMatchObject({ _tag: "Failure" })
    expect(Exit.isFailure(fail) && Cause.hasDies(fail.cause)).toBe(false)
    expect(closed).toBe(1)
    const malformed = await Effect.runPromiseExit(
      extract(async () => Response.json({ invalid: true }))(new Uint8Array())
    )
    expect(Exit.isFailure(malformed) && Cause.hasDies(malformed.cause)).toBe(
      true
    )
    const cleanup = await Effect.runPromiseExit(
      extract(
        async () =>
          new Response(
            new ReadableStream({
              cancel() {
                throw new TypeError("Private cleanup defect")
              },
            }),
            { status: 503 }
          )
      )(new Uint8Array())
    )
    expect(Exit.isFailure(cleanup) && Cause.hasDies(cleanup.cause)).toBe(true)
  }
)

it("interrupts multipart ingress without admitting a file and joins reader cancellation", async () => {
  const reading = gate(),
    cleaning = gate(),
    close = gate(),
    abort = new AbortController()
  let settled = false
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        reading.release()
        return new Promise<void>(() => {})
      },
      async cancel() {
        cleaning.release()
        await close.waiting
      },
    },
    { highWaterMark: 0 }
  )
  const ledger = new SqliteWorkspace(database())
  const assets = r2WorkspaceAssets(
    {
      get: async () => null,
      put: async () => {
        throw new Error("No asset write is permitted")
      },
    },
    "owner"
  )
  const workspace = makeWorkspace(
    ledger,
    assets,
    () => true,
    () => Effect.fail(new WorkspaceUnavailable()),
    () => Effect.fail(new WorkspaceUnavailable())
  )
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    body,
    duplex: "half",
    headers: { "content-type": "multipart/form-data; boundary=abc" },
  }
  const request = new Request("https://app.test/files/upload", init)
  const work = Effect.runPromiseExit(
    filesRequest(request, "files/upload").pipe(
      Effect.provide(Layer.succeed(Workspace, workspace))
    ),
    { signal: abort.signal }
  ).then((exit) => {
    settled = true
    return exit
  })
  await reading.waiting
  abort.abort()
  await cleaning.waiting
  expect(settled).toBe(false)
  close.release()
  const exit = await work
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  expect(ledger.list()).toEqual([])
  expect(body.locked).toBe(false)
})

it("does not turn oversized input plus failed reader cancellation into an ordinary file rejection", async () => {
  const cleanup = new Error("Private request cleanup failure")
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(2049))
    },
    cancel() {
      throw cleanup
    },
  })
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    body,
    duplex: "half",
  }
  const ledger = new SqliteWorkspace(database())
  const assets = r2WorkspaceAssets(
    { get: async () => null, put: async () => {} },
    "private"
  )
  const workspace = makeWorkspace(
    ledger,
    assets,
    () => true,
    () => Effect.fail(new WorkspaceUnavailable()),
    () => Effect.fail(new WorkspaceUnavailable())
  )
  const exit = await Effect.runPromiseExit(
    filesRequest(
      new Request(
        "https://app.test/files/00000000-0000-4000-8000-000000000001/rename",
        init
      ),
      "files/00000000-0000-4000-8000-000000000001/rename"
    ).pipe(Effect.provide(Layer.succeed(Workspace, workspace)))
  )
  expect(
    Exit.isFailure(exit) &&
      exit.cause.reasons.some(
        (reason) => reason._tag === "Die" && reason.defect === cleanup
      )
  ).toBe(true)
  expect(ledger.list()).toEqual([])
  expect(body.locked).toBe(false)
})
