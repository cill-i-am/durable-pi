import { afterEach, expect, it } from "vitest"
import { it as effectIt } from "@effect/vitest"
import { Cause, Effect, Exit, ManagedRuntime, Semaphore } from "effect"
import { TestClock } from "effect/testing"
import { database, corrupt } from "./database"
import { SqliteWorkspace } from "../src/workspace/adapters/sqlite"
import {
  r2WorkspaceAssets,
  type AssetBucket,
} from "../src/workspace/adapters/r2"
import { makeWorkspace } from "../src/workspace/service"
import { Workspace } from "../src/workspace/workspace"
import {
  workspaceExtractionCycle,
  workspaceExtractionFailure,
} from "../src/workspace/application"
import { WorkspaceAdmission } from "../src/workspace/admission"
import { workspaceLayer } from "../src/workspace/adapters/storage"
import { WorkspaceUnavailable, type Upload } from "../src/workspace/files"
import {
  DocumentUnreadable,
  type ExtractDocument,
  type ExtractedDocument,
} from "../src/workspace/documents"
import { VideoUnreadable, type ExtractVideo } from "../src/workspace/video"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})
const upload = (
  name = "note.md",
  mime = "text/plain",
  text = "Private note"
): Upload => ({
  id: crypto.randomUUID(),
  name,
  mime,
  bytes: new TextEncoder().encode(text),
})
const document: ExtractedDocument = {
  text: "[Page 1]\nPrivate extracted text",
  pages: 1,
  readPages: 1,
  truncated: false,
}
const pdf = () => upload("note.pdf", "application/pdf", "%PDF-synthetic")
function fixture(
  extract: ExtractDocument = () => Effect.succeed(document),
  video: ExtractVideo = () => Effect.fail(new WorkspaceUnavailable()),
  db = database()
) {
  const values = new Map<string, Uint8Array>(),
    state = { writable: true },
    calls = { reads: 0, writes: 0, releases: 0 }
  const bucket: AssetBucket = {
    put: async (key, bytes) => {
      calls.writes++
      values.set(key, bytes.slice())
    },
    get: async (key) => {
      calls.reads++
      const bytes = values.get(key)
      return bytes
        ? {
            body: new ReadableStream({
              cancel() {
                calls.releases++
              },
            }),
            arrayBuffer: async () => bytes.slice().buffer,
          }
        : null
    },
  }
  const ledger = new SqliteWorkspace(db),
    assets = r2WorkspaceAssets(bucket, "private-owner")
  return {
    db,
    ledger,
    assets,
    bucket,
    state,
    values,
    calls,
    workspace: makeWorkspace(
      ledger,
      assets,
      () => Effect.sync(() => state.writable),
      extract,
      video
    ),
  }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

effectIt.effect(
  "upload reservations and video backoff use invocation Clock while replay retains the original date",
  () =>
    Effect.gen(function* () {
      const f = fixture(),
        input = upload()
      yield* TestClock.setTime(20_000)
      const first = yield* f.workspace.upload(input)
      expect(first.createdAt).toBe("1970-01-01T00:00:20.000Z")
      yield* TestClock.setTime(25_000)
      yield* f.workspace.rename(input.id, "renamed.md")
      expect(yield* f.workspace.upload(input)).toMatchObject({
        name: "renamed.md",
        createdAt: first.createdAt,
      })
      const clip: Upload = {
        ...upload("clip.mp4", "video/mp4"),
        bytes: Uint8Array.of(0, 0, 0, 24, 102, 116, 121, 112),
      }
      yield* f.workspace.upload(clip)
      yield* f.workspace.extractNext()
      expect(yield* f.ledger.video(clip.id)).toMatchObject({
        attempts: 1,
        retryAt: 85_000,
      })
      expect(yield* f.workspace.extractNext()).toBe(false)
      yield* TestClock.adjust("60 seconds")
      expect(yield* f.workspace.extractNext()).toBe(true)
      expect((yield* f.ledger.video(clip.id))?.attempts).toBe(2)
    })
)

it("rolls back failed ready publication while retaining the reservation and exact asset for retry", async () => {
  const native = database()
  const db = native
  const f = fixture(undefined, undefined, db),
    input = upload(),
    write = f.bucket.put
  f.bucket.put = async (...args) => {
    await write(...args)
    native.run(
      "CREATE TRIGGER reject_file_ready BEFORE UPDATE OF status ON workspace_files BEGIN SELECT RAISE(ABORT,'Commit not acknowledged'); END"
    )
  }
  expect(
    await Effect.runPromise(f.workspace.upload(input).pipe(Effect.result))
  ).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "WorkspaceUnavailable" },
  })
  expect(Effect.runSync(f.ledger.read(input.id))?.status).toBe("uploading")
  expect(f.values.size).toBe(1)
  native.run("DROP TRIGGER reject_file_ready")
  f.bucket.put = write
  const result = await Effect.runPromise(f.workspace.upload(input))
  expect(result.status).toBe("ready")
  expect(Effect.runSync(f.ledger.list())).toHaveLength(1)
  expect(f.values.size).toBe(1)
})

it("keeps malformed file/job records as defects and performs no asset read for corrupt metadata", async () => {
  const f = fixture(),
    input = pdf()
  await Effect.runPromise(f.workspace.upload(input))
  corrupt(
    f.db,
    "UPDATE workspace_extractions SET status='corrupt' WHERE id=?",
    input.id
  )
  const job = await Effect.runPromiseExit(f.workspace.list())
  expect(Exit.isFailure(job) && Cause.hasDies(job.cause)).toBe(true)
  const content = await Effect.runPromiseExit(
    Effect.scoped(f.workspace.content(input.id))
  )
  expect(Exit.isFailure(content) && Cause.hasDies(content.cause)).toBe(true)
  expect(f.calls.reads).toBe(0)
  corrupt(
    f.db,
    "UPDATE workspace_files SET kind='corrupt' WHERE id=?",
    input.id
  )
  const row = await Effect.runPromiseExit(f.workspace.requireFiles([input.id]))
  expect(Exit.isFailure(row) && Cause.hasDies(row.cause)).toBe(true)
})

it("does not publish a PDF result after a newer preparation generation claimed the job", async () => {
  const entered = deferred(),
    release = deferred()
  const f = fixture(() =>
      Effect.promise(async () => {
        entered.resolve()
        await release.promise
        return document
      })
    ),
    input = pdf()
  await Effect.runPromise(f.workspace.upload(input))
  const pending = Effect.runPromise(f.workspace.extractNext())
  await entered.promise
  corrupt(
    f.db,
    "UPDATE workspace_extractions SET attempts=2,status='running' WHERE id=?",
    input.id
  )
  release.resolve()
  expect(await pending).toBe(true)
  expect(Effect.runSync(f.ledger.document(input.id))).toMatchObject({
    status: "running",
    attempts: 2,
    pages: 0,
  })
  expect([...f.values.keys()].some((key) => key.endsWith("pdf-text-v1"))).toBe(
    false
  )
})

it("pauses PDF publication after archive and resumes through the same durable job after restore", async () => {
  const entered = deferred(),
    release = deferred()
  const f = fixture(() =>
      Effect.promise(async () => {
        entered.resolve()
        await release.promise
        return document
      })
    ),
    input = pdf()
  await Effect.runPromise(f.workspace.upload(input))
  const pending = Effect.runPromise(f.workspace.extractNext())
  await entered.promise
  f.state.writable = false
  release.resolve()
  await pending
  expect(Effect.runSync(f.ledger.document(input.id))).toMatchObject({
    status: "pending",
    attempts: 1,
  })
  expect(await Effect.runPromise(f.workspace.extractionPending())).toBe(false)
  expect([...f.values.keys()].some((key) => key.endsWith("pdf-text-v1"))).toBe(
    false
  )
  f.state.writable = true
  await Effect.runPromise(f.workspace.extractNext())
  expect(Effect.runSync(f.ledger.document(input.id))).toMatchObject({
    status: "ready",
    attempts: 2,
  })
  expect(
    (await Effect.runPromise(f.workspace.readText(input.id, 0, 100))).text
  ).toBe(document.text)
})

it("rechecks authority after original acquisition before dispatching the document decoder", async () => {
  let decodes = 0
  const f = fixture(() => {
      decodes++
      return Effect.succeed(document)
    }),
    input = pdf(),
    get = f.bucket.get
  await Effect.runPromise(f.workspace.upload(input))
  f.bucket.get = async (...args) => {
    const result = await get(...args)
    f.state.writable = false
    return result
  }
  await Effect.runPromise(f.workspace.extractNext())
  expect(decodes).toBe(0)
  expect(Effect.runSync(f.ledger.document(input.id))?.status).toBe("pending")
})

it("joins an interrupted R2 body and its release before caller resources close", async () => {
  const f = fixture(),
    input = upload(),
    entered = deferred(),
    release = deferred(),
    cleanupEntered = deferred(),
    cleanupRelease = deferred()
  await Effect.runPromise(f.workspace.upload(input))
  f.bucket.get = async () => ({
    body: new ReadableStream({
      async cancel() {
        cleanupEntered.resolve()
        await cleanupRelease.promise
      },
    }),
    arrayBuffer: async () => {
      entered.resolve()
      await release.promise
      return input.bytes.slice().buffer
    },
  })
  let alive = false,
    finished = false
  const controller = new AbortController()
  const pending = Effect.runPromiseExit(
    Effect.acquireUseRelease(
      Effect.sync(() => {
        alive = true
      }),
      () => f.workspace.readText(input.id, 0, 10),
      () =>
        Effect.sync(() => {
          alive = false
        })
    ),
    { signal: controller.signal }
  ).then((result) => {
    finished = true
    return result
  })
  await entered.promise
  controller.abort()
  expect(alive).toBe(true)
  expect(finished).toBe(false)
  release.resolve()
  await cleanupEntered.promise
  expect(alive).toBe(true)
  expect(finished).toBe(false)
  cleanupRelease.resolve()
  const result = await pending
  expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true)
  expect(alive).toBe(false)
})

it("retains shared native transaction identity for final attachment eligibility", async () => {
  const f = fixture(),
    runtime = ManagedRuntime.make(
      workspaceLayer(f.db, f.bucket, "private-owner")
    )
  cleanups.push(() => runtime.dispose())
  const admission = runtime.runSync(WorkspaceAdmission),
    workspace = runtime.runSync(Workspace),
    input = upload()
  await runtime.runPromise(workspace.upload(input))
  expect(admission.transactionGroup).toBe(f.db)
  expect(
    Effect.runSync(f.db.transaction(() => admission.requireFiles([input.id])))
  ).toHaveLength(1)
  await runtime.runPromise(workspace.trash(input.id, true))
  expect(() =>
    Effect.runSync(f.db.transaction(() => admission.requireFiles([input.id])))
  ).toThrow()
  expect(
    JSON.stringify(await runtime.runPromise(workspace.list()))
  ).not.toMatch(/private-owner|hash|Private note/)
})

it("serializes preparation calls and claims each file once instead of treating live work as crash recovery", async () => {
  const entered = deferred(),
    release = deferred()
  let decodes = 0,
    active = 0,
    maximum = 0
  const f = fixture(() =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        decodes++
        active++
        maximum = Math.max(maximum, active)
      }),
      () =>
        Effect.promise(async () => {
          if (decodes === 1) {
            entered.resolve()
            await release.promise
          }
          return document
        }),
      () =>
        Effect.sync(() => {
          active--
        })
    )
  )
  const first = pdf(),
    second = pdf()
  await Effect.runPromise(f.workspace.upload(first))
  await Effect.runPromise(f.workspace.upload(second))
  const one = Effect.runPromise(f.workspace.extractNext())
  await entered.promise
  const two = Effect.runPromise(f.workspace.extractNext())
  expect(decodes).toBe(1)
  release.resolve()
  expect(await one).toBe(true)
  expect(await two).toBe(true)
  expect(maximum).toBe(1)
  expect(decodes).toBe(2)
  expect(Effect.runSync(f.ledger.document(first.id))).toMatchObject({
    status: "ready",
    attempts: 1,
  })
  expect(Effect.runSync(f.ledger.document(second.id))).toMatchObject({
    status: "ready",
    attempts: 1,
  })
})

it("interrupted upload joins its native write, retains an exact reservation, and snapshots caller bytes", async () => {
  const f = fixture(),
    input = upload(),
    original = { ...input, bytes: input.bytes.slice() },
    entered = deferred(),
    release = deferred(),
    second = deferred()
  const permit = Semaphore.makeUnsafe(1),
    abort = new AbortController(),
    put = f.bucket.put
  let completed = false,
    calls = 0
  f.bucket.put = async (...args) => {
    if (calls++ === 0) {
      entered.resolve()
      await release.promise
    }
    await put(...args)
  }
  const first = Effect.runPromiseExit(
    permit.withPermits(1)(f.workspace.upload(input)),
    { signal: abort.signal }
  ).then((exit) => {
    completed = true
    return exit
  })
  await entered.promise
  input.bytes.fill(120)
  const date = Effect.runSync(f.ledger.read(input.id))!.createdAt
  abort.abort()
  const replay = Effect.runPromise(
    permit.withPermits(1)(
      Effect.sync(() => {
        second.resolve()
      }).pipe(Effect.andThen(f.workspace.upload(original)))
    )
  )
  await Promise.resolve()
  expect(completed).toBe(false)
  expect(calls).toBe(1)
  expect(Effect.runSync(f.ledger.read(input.id))?.status).toBe("uploading")
  release.resolve()
  const exit = await first
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  await second.promise
  expect(await replay).toMatchObject({ status: "ready", createdAt: date })
  expect(
    (await Effect.runPromise(f.workspace.readText(input.id, 0, 100))).text
  ).toBe("Private note")
  expect(calls).toBe(2)
})

effectIt.effect(
  "preparation scheduling uses invocation Clock for active, idle and failed cycles",
  () =>
    Effect.gen(function* () {
      const f = fixture(),
        input = pdf()
      yield* TestClock.setTime(123000)
      yield* f.workspace.upload(input)
      const workspace = {
        ...f.workspace,
        extractNext: () => Effect.succeed(false),
      }
      expect(
        yield* workspaceExtractionCycle().pipe(
          Effect.provideService(Workspace, workspace)
        )
      ).toBe(153000)
      expect(
        yield* workspaceExtractionCycle().pipe(
          Effect.provideService(Workspace, {
            ...workspace,
            extractNext: () => Effect.succeed(true),
          })
        )
      ).toBe(124000)
      expect(yield* workspaceExtractionFailure).toBe(183000)
      yield* f.workspace.extractNext()
      expect(
        yield* workspaceExtractionCycle().pipe(
          Effect.provideService(Workspace, f.workspace)
        )
      ).toBeUndefined()
    })
)

it.each(["pdf", "video"])(
  "does not turn %s decoder cleanup defects into a failed job or retry",
  async (kind) => {
    const cleanup = new Error("Private decoder cleanup failure")
    const f = fixture(
      () =>
        Effect.fail(new DocumentUnreadable({ reason: "invalid" })).pipe(
          Effect.ensuring(Effect.die(cleanup))
        ),
      () =>
        Effect.fail(new VideoUnreadable()).pipe(
          Effect.ensuring(Effect.die(cleanup))
        )
    )
    const input =
      kind === "pdf"
        ? pdf()
        : {
            ...upload("clip.mp4", "video/mp4"),
            bytes: Uint8Array.of(0, 0, 0, 24, 102, 116, 121, 112),
          }
    await Effect.runPromise(f.workspace.upload(input))
    const exit = await Effect.runPromiseExit(f.workspace.extractNext())
    expect(
      Exit.isFailure(exit) &&
        exit.cause.reasons.some(
          (reason) => reason._tag === "Die" && reason.defect === cleanup
        )
    ).toBe(true)
    expect(
      kind === "pdf"
        ? Effect.runSync(f.ledger.document(input.id))
        : Effect.runSync(f.ledger.video(input.id))
    ).toMatchObject({ status: "running", attempts: 1, error: null })
  }
)
