import { expect, expectTypeOf, it, vi } from "vitest"
import { it as effectIt } from "@effect/vitest"
import { Cause, Effect, Exit, ManagedRuntime, Stream } from "effect"
import { TestClock } from "effect/testing"
import {
  workspaceFileImport,
  type TerminalImports,
} from "../src/terminal/workspace-import"
import { terminalImports } from "../src/terminal/adapters/import-service"
import { importWorkspaceFile } from "../src/terminal/adapters/file-import"
import { terminalRequest } from "../src/terminal/adapters/http"
import {
  checkpointStorage,
  type CheckpointBucket,
} from "../src/terminal/adapters/r2"
import { fileDigest } from "../src/terminal/adapters/files"
import { terminalFileDigest } from "../src/terminal/adapters/interop"
import {
  type CommandRun,
  MAX_CHECKPOINT,
  TerminalFailure,
} from "../src/terminal/contracts"
import { MAX_TRANSFER_BYTES } from "../src/terminal/transfers"
import {
  TerminalRuntimeError,
  type TerminalRuntime,
} from "../src/terminal/runtime"
import {
  TerminalService,
  terminalLayer,
  type TerminalOperations,
} from "../src/terminal/terminal"
import type { FileContent, Workspace } from "../src/workspace/workspace"
import { database } from "./database"
import { TerminalStore } from "../src/terminal/adapters/sqlite"

const id = "d04a5143-0a58-4bf1-8b48-3daacfb59b29"
const fileId = "254b5eb0-3e6e-460f-afd1-ae754d977aae"
const bytes = new TextEncoder().encode("Private source")
const input = { id, fileId }
const run: CommandRun = {
  id,
  command: "Import file",
  kind: "import",
  status: "succeeded",
  transfer: {
    kind: "import",
    fileId,
    name: "source.txt",
    path: `/workspace/imports/${id}/source.txt`,
    sha256: "a".repeat(64),
  },
  output: "",
  exitCode: 0,
  error: null,
  createdAt: 10,
  finishedAt: 20,
  savedAt: 20,
}
const content: FileContent = {
  info: {
    id: fileId,
    name: "source.txt",
    mime: "text/plain",
    kind: "text",
    size: bytes.length,
    createdAt: "legacy",
    status: "ready",
    trashed: false,
  },
  mime: "text/plain",
  size: bytes.length,
  body: Stream.make(bytes),
}
const unavailable = () =>
  new TerminalRuntimeError({ operation: "synthetic", cause: "private" })
function gate<T = void>() {
  let release!: (value: T) => void
  const waiting = new Promise<T>((resolve) => {
    release = resolve
  })
  return { waiting, release }
}
function failures(exit: Exit.Exit<unknown, unknown>) {
  return Exit.isFailure(exit) ? exit.cause.reasons : []
}
function importer(
  overrides: Partial<TerminalImports> = {},
  source: Pick<Workspace["Service"], "content"> = {
    content: () => Effect.succeed(content),
  },
  active = () => Effect.succeed(true)
) {
  const copy = vi.fn<TerminalImports["copy"]>(() =>
    Effect.succeed({ kind: "accepted", run })
  )
  const find = vi.fn<TerminalImports["find"]>(() => Effect.succeed(null))
  return {
    copy,
    find,
    import: workspaceFileImport(source, { copy, find, ...overrides }, active),
  }
}
function request(body = JSON.stringify(input)) {
  return new Request("https://agent.internal/terminal/files/import", {
    method: "POST",
    body,
  })
}
const unsupported = () => Effect.die(new Error("Unexpected Terminal operation"))
function terminal(
  overrides: Partial<TerminalOperations> = {}
): TerminalOperations {
  return {
    get: unsupported,
    state: unsupported,
    configure: unsupported,
    configureNetwork: unsupported,
    recover: unsupported,
    start: unsupported,
    startTransfer: unsupported,
    startImport: unsupported,
    startSession: unsupported,
    session: unsupported,
    cancel: unsupported,
    exportedFile: unsupported,
    ...overrides,
  }
}

it("reconciles an ambiguous import acknowledgement by reading once, without a second copy", async () => {
  const find = vi
    .fn<TerminalImports["find"]>()
    .mockReturnValueOnce(Effect.succeed(null))
    .mockReturnValueOnce(Effect.succeed(run))
  const copy = vi.fn<TerminalImports["copy"]>(() => Effect.fail(unavailable()))
  const f = importer({ find, copy })
  expect(await Effect.runPromise(f.import(input))).toEqual(run)
  expect(find).toHaveBeenCalledTimes(2)
  expect(copy).toHaveBeenCalledOnce()
})

it("retains an unconfirmed import failure and never redispatches when reconciliation finds no receipt", async () => {
  const error = unavailable(),
    copy = vi.fn<TerminalImports["copy"]>(() => Effect.fail(error))
  const f = importer({ copy })
  const exit = await Effect.runPromiseExit(f.import(input))
  expect(failures(exit)).toContainEqual(
    expect.objectContaining({ _tag: "Fail", error })
  )
  expect(f.find).toHaveBeenCalledTimes(2)
  expect(copy).toHaveBeenCalledOnce()
})

it("checks archive authority before acquiring a source and again before admitting its copy", async () => {
  const source = vi.fn(() => Effect.succeed(content))
  const archived = importer({}, { content: source }, () =>
    Effect.succeed(false)
  )
  expect(
    Exit.isFailure(await Effect.runPromiseExit(archived.import(input)))
  ).toBe(true)
  expect(source).not.toHaveBeenCalled()
  let active = true
  const changing = importer(
    {},
    {
      content: () =>
        Effect.succeed({
          ...content,
          body: Stream.make(bytes).pipe(
            Stream.tap(() =>
              Effect.sync(() => {
                active = false
              })
            )
          ),
        }),
    },
    () => Effect.sync(() => active)
  )
  expect(
    Exit.isFailure(await Effect.runPromiseExit(changing.import(input)))
  ).toBe(true)
  expect(changing.copy).not.toHaveBeenCalled()
})

it("treats a mismatched owned source identity as a defect before transfer admission", async () => {
  const f = importer(
    {},
    {
      content: () =>
        Effect.succeed({
          ...content,
          info: { ...content.info, id: crypto.randomUUID() },
        }),
    }
  )
  const exit = await Effect.runPromiseExit(f.import(input))
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  expect(f.copy).not.toHaveBeenCalled()
})

it("bounds source stream bytes and joins its scope before returning the rejected copy", async () => {
  const cleaning = gate(),
    release = gate()
  const f = importer(
    {},
    {
      content: () =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              cleaning.release()
              await release.waiting
            })
          )
          return {
            ...content,
            body: Stream.make(new Uint8Array(MAX_TRANSFER_BYTES + 1)),
          }
        }),
    }
  )
  let ended = false
  const pending = Effect.runPromiseExit(f.import(input)).then((exit) => {
    ended = true
    return exit
  })
  await cleaning.waiting
  expect(ended).toBe(false)
  release.release()
  expect(Exit.isFailure(await pending)).toBe(true)
  expect(f.copy).not.toHaveBeenCalled()
})

it("does not reconcile a copy defect or conceal a mixed cleanup failure as a receipt", async () => {
  const defect = new TerminalFailure({ message: "private invariant" }),
    cleanup = new Error("private cleanup")
  for (const work of [
    Effect.die(defect),
    Effect.fail(unavailable()).pipe(Effect.ensuring(Effect.die(cleanup))),
  ]) {
    const f = importer({ copy: () => work })
    const exit = await Effect.runPromiseExit(f.import(input))
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    expect(f.find).toHaveBeenCalledOnce()
  }
})

it("handles expected Terminal error tags without depending on their prototypes", async () => {
  const error = new TerminalFailure({ message: "Restore this bot." })
  Object.setPrototypeOf(error, null)
  const program = terminalRequest(
    terminal({ state: () => Effect.fail(error) }),
    new Request("https://terminal.internal/terminal"),
    "terminal",
    () => {}
  )
  expectTypeOf(program).toEqualTypeOf<Effect.Effect<Response>>()
  const response = await Effect.runPromise(program)
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ error: "Restore this bot." })
})

it("preserves tagged defects and mixed causes at both transfer HTTP boundaries", async () => {
  const defect = new TerminalFailure({ message: "private invariant" }),
    cleanup = new Error("private cleanup")
  const work = Effect.fail(unavailable()).pipe(
    Effect.ensuring(Effect.die(cleanup))
  )
  for (const program of [
    terminalRequest(
      terminal({ state: () => Effect.die(defect) }),
      new Request("https://terminal.internal/terminal"),
      "terminal",
      () => {}
    ),
    terminalRequest(
      terminal({ state: () => work }),
      new Request("https://terminal.internal/terminal"),
      "terminal",
      () => {}
    ),
    importWorkspaceFile(() => work, request()),
  ]) {
    const exit = await Effect.runPromiseExit(program)
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  }
})

it("rejects malformed and oversized transfer input before any command or copy admission", async () => {
  const copy = vi.fn(() => Effect.succeed(run)),
    start = vi.fn(unsupported)
  for (const body of [
    "{",
    "x".repeat(2049),
    JSON.stringify({ id, fileId: "invalid" }),
  ]) {
    expect(
      (await Effect.runPromise(importWorkspaceFile(copy, request(body)))).status
    ).toBe(409)
  }
  for (const body of [
    "{",
    JSON.stringify({ id, command: "x".repeat(128001) }),
  ]) {
    expect(
      (
        await Effect.runPromise(
          terminalRequest(
            terminal({ start }),
            request(body),
            "terminal/run",
            () => {}
          )
        )
      ).status
    ).toBe(409)
  }
  expect(copy).not.toHaveBeenCalled()
  expect(start).not.toHaveBeenCalled()
})

it("pre-cancelled host invocations admit neither a workspace copy nor a Terminal operation", async () => {
  const controller = new AbortController(),
    copy = vi.fn(() => Effect.succeed(run)),
    state = vi.fn(unsupported)
  controller.abort()
  for (const program of [
    importWorkspaceFile(copy, request()),
    terminalRequest(
      terminal({ state }),
      new Request("https://terminal.internal/terminal"),
      "terminal",
      () => {}
    ),
  ]) {
    const exit = await Effect.runPromiseExit(program, {
      signal: controller.signal,
    })
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  }
  expect(copy).not.toHaveBeenCalled()
  expect(state).not.toHaveBeenCalled()
})

it("joins cancelled inbound body readers and retains cleanup rejection as a defect", async () => {
  const entered = gate(),
    cleaning = gate(),
    release = gate(),
    controller = new AbortController(),
    copy = vi.fn(() => Effect.succeed(run))
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        entered.release()
      },
      async cancel() {
        cleaning.release()
        await release.waiting
        throw new Error("reader cleanup")
      },
    },
    { highWaterMark: 0 }
  )
  const req = new Request("https://agent.internal/", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit)
  let ended = false
  const pending = Effect.runPromiseExit(importWorkspaceFile(copy, req), {
    signal: controller.signal,
  }).then((exit) => {
    ended = true
    return exit
  })
  await entered.waiting
  controller.abort()
  await cleaning.waiting
  expect(ended).toBe(false)
  release.release()
  const exit = await pending
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  expect(copy).not.toHaveBeenCalled()
  expect(body.locked).toBe(false)
})

for (const operation of ["find", "copy"] as const) {
  it(`joins the unread ${operation === "find" ? "missing receipt" : "losing conflict"} response before returning`, async () => {
    const cleaning = gate(),
      release = gate()
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            async cancel() {
              cleaning.release()
              await release.waiting
            },
          }),
          { status: operation === "find" ? 404 : 409 }
        )
    )
    const remote = terminalImports({ fetch }, "bot")
    let ended = false
    const work: Effect.Effect<unknown, TerminalRuntimeError> =
      operation === "find"
        ? remote.find(id)
        : remote.copy(input, content, bytes)
    const pending = Effect.runPromise(work).then((value) => {
      ended = true
      return value
    })
    await cleaning.waiting
    expect(ended).toBe(false)
    release.release()
    expect(await pending).toEqual(
      operation === "find" ? null : { kind: "conflict" }
    )
  })
  it(`releases a late ${operation} response after abort and joins its cleanup`, async () => {
    const entered = gate(),
      acquired = gate<Response>(),
      cleaning = gate(),
      release = gate(),
      controller = new AbortController()
    let signal: AbortSignal | undefined,
      ended = false
    const remote = terminalImports(
      {
        fetch: (req) => {
          signal = req.signal
          entered.release()
          return acquired.waiting
        },
      },
      "bot"
    )
    const work: Effect.Effect<unknown, TerminalRuntimeError> =
      operation === "find"
        ? remote.find(id)
        : remote.copy(input, content, bytes)
    const pending = Effect.runPromiseExit(work, {
      signal: controller.signal,
    }).then((exit) => {
      ended = true
      return exit
    })
    await entered.waiting
    controller.abort()
    expect(signal?.aborted).toBe(true)
    acquired.release(
      new Response(
        new ReadableStream({
          async cancel() {
            cleaning.release()
            await release.waiting
          },
        })
      )
    )
    await cleaning.waiting
    expect(ended).toBe(false)
    release.release()
    const exit = await pending
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  })
}

it("bounds and validates receipt bodies without exposing private transport details", async () => {
  for (const response of [
    new Response("private malformed json"),
    new Response(new Uint8Array(512 * 1024 + 1)),
  ]) {
    const remote = terminalImports({ fetch: async () => response }, "bot")
    const http = await Effect.runPromise(
      importWorkspaceFile(
        workspaceFileImport({ content: unsupported }, remote, () =>
          Effect.succeed(true)
        ),
        request()
      )
    )
    expect(http.status).toBe(409)
    expect(await http.text()).not.toContain("private")
    expect(response.body?.locked).toBe(false)
  }
})

it("releases oversized R2 objects and never reads outside the checkpoint owner's prefix", async () => {
  const cancel = vi.fn(async () => {}),
    get = vi.fn(async () => ({
      size: MAX_CHECKPOINT + 1,
      body: new ReadableStream<Uint8Array>({ cancel }),
    }))
  const storage = checkpointStorage({ get, put: async () => {} }, "owner")
  const checkpoint = {
    key: "terminal/other/hash.tar.gz",
    sha256: "hash",
    size: 1,
    savedAt: 0,
  }
  expect(
    Exit.isFailure(await Effect.runPromiseExit(storage.read(checkpoint)))
  ).toBe(true)
  expect(get).not.toHaveBeenCalled()
  expect(
    Exit.isFailure(
      await Effect.runPromiseExit(
        storage.read({ ...checkpoint, key: "terminal/owner/hash.tar.gz" })
      )
    )
  ).toBe(true)
  expect(cancel).toHaveBeenCalledOnce()
})

it("releases late R2 acquisition after abort and joins its unread body cancellation", async () => {
  const entered = gate(),
    acquired = gate<Awaited<ReturnType<CheckpointBucket["get"]>>>(),
    cleaning = gate(),
    release = gate(),
    controller = new AbortController()
  const storage = checkpointStorage(
    {
      get: () => {
        entered.release()
        return acquired.waiting
      },
      put: async () => {},
    },
    "owner"
  )
  let ended = false
  const pending = Effect.runPromiseExit(
    storage.read({
      key: "terminal/owner/hash.tar.gz",
      size: 1,
      sha256: "hash",
      savedAt: 0,
    }),
    { signal: controller.signal }
  ).then((exit) => {
    ended = true
    return exit
  })
  await entered.waiting
  controller.abort()
  acquired.release({
    size: 1,
    body: new ReadableStream({
      async cancel() {
        cleaning.release()
        await release.waiting
      },
    }),
  })
  await cleaning.waiting
  expect(ended).toBe(false)
  release.release()
  const exit = await pending
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
})

it("validates R2 size and checksum and preserves failed release as a defect", async () => {
  const checkpoint = {
    key: "terminal/owner/hash.tar.gz",
    size: bytes.length,
    sha256: await fileDigest(bytes),
    savedAt: 0,
  }
  const storage = checkpointStorage(
    {
      get: async () => ({
        size: bytes.length,
        body: new Blob([bytes]).stream(),
      }),
      put: async () => {},
    },
    "owner"
  )
  expect(await Effect.runPromise(storage.read(checkpoint))).toEqual(bytes)
  for (const invalid of [
    { ...checkpoint, size: bytes.length + 1 },
    { ...checkpoint, sha256: "invalid" },
  ])
    expect(
      Exit.isFailure(await Effect.runPromiseExit(storage.read(invalid)))
    ).toBe(true)
  const broken = checkpointStorage(
    {
      get: async () => ({
        size: MAX_CHECKPOINT + 1,
        body: new ReadableStream({
          cancel() {
            throw new Error("private R2 cleanup")
          },
        }),
      }),
      put: async () => {},
    },
    "owner"
  )
  const exit = await Effect.runPromiseExit(broken.read(checkpoint))
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
})

effectIt.effect(
  "uses invocation Clock for R2 receipts and writes the captured bytes under the unchanged key format",
  () =>
    Effect.gen(function* () {
      const put = vi.fn(async () => {}),
        storage = checkpointStorage(
          { get: async () => null, put },
          "owner",
          "file"
        )
      yield* TestClock.setTime(1234)
      const record = yield* storage.write(bytes)
      expect(record).toEqual({
        key: `terminal/owner/exports/${awaitedDigest}.bin`,
        sha256: awaitedDigest,
        size: bytes.length,
        savedAt: 1234,
      })
      expect(put).toHaveBeenCalledWith(record.key, bytes, {
        httpMetadata: { contentType: "application/octet-stream" },
      })
    })
)
const awaitedDigest = await fileDigest(bytes)

it("joins R2 writes after interruption and protects bytes from caller mutation", async () => {
  const entered = gate(),
    release = gate(),
    controller = new AbortController(),
    source = bytes.slice()
  let captured: Uint8Array | undefined,
    ended = false
  const storage = checkpointStorage(
    {
      get: async () => null,
      put: async (_key, value) => {
        captured = value
        entered.release()
        await release.waiting
      },
    },
    "owner"
  )
  const pending = Effect.runPromiseExit(storage.write(source), {
    signal: controller.signal,
  }).then((exit) => {
    ended = true
    return exit
  })
  await entered.waiting
  source.fill(0)
  controller.abort()
  expect(ended).toBe(false)
  expect(captured).toEqual(bytes)
  release.release()
  const exit = await pending
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
})

it("native multipart admission hashes a private byte snapshot once and replays its durable receipt", async () => {
  const repository = new TerminalStore(database()),
    digest = vi.fn(terminalFileDigest),
    imported: Uint8Array[] = []
  Effect.runSync(repository.configure(0, true))
  const host: TerminalRuntime = {
    restore: () => Effect.void,
    execute: unsupported,
    snapshot: () => Effect.succeed(bytes),
    importFile: (_path, payload) =>
      Effect.sync(() => {
        imported.push(payload.slice())
      }),
    exportFile: () => Effect.succeed(bytes),
    openInteractive: unsupported,
    close: () => Effect.void,
    settle: () => Effect.void,
  }
  const storage = {
    read: () => Effect.succeed(bytes),
    write: () =>
      Effect.succeed({
        key: "snapshot",
        size: bytes.length,
        sha256: awaitedDigest,
        savedAt: 0,
      }),
    settle: () => Effect.void,
  }
  const runtime = ManagedRuntime.make(
    terminalLayer({
      repository,
      runtime: host,
      backups: storage,
      relay: () => {
        throw new Error("Unexpected socket")
      },
      digest,
    })
  )
  try {
    const service = runtime.runSync(TerminalService)
    const form = new FormData()
    form.set("id", id)
    form.set("fileId", fileId)
    form.set("file", new Blob([bytes]), "source.txt")
    const work: Promise<void>[] = []
    const response = await runtime.runPromise(
      terminalRequest(
        service,
        new Request("https://terminal.internal/terminal/import", {
          method: "POST",
          body: form,
        }),
        "terminal/import",
        (task) => {
          work.push(runtime.runPromise(task))
        }
      )
    )
    expect(response.status).toBe(202)
    await Promise.all(work)
    expect(digest).toHaveBeenCalledOnce()
    expect(imported).toEqual([bytes])
    const saved = Effect.runSync(repository.get(id))
    const original = bytes.slice(),
      nextId = crypto.randomUUID(),
      entered = gate(),
      release = gate()
    digest.mockImplementationOnce((payload) =>
      Effect.promise(async () => {
        entered.release()
        await release.waiting
        return fileDigest(payload)
      })
    )
    const pending = runtime.runPromise(
      service.startImport({ id: nextId, fileId, name: "next.txt" }, original)
    )
    await entered.waiting
    original.fill(0)
    release.release()
    await (await pending).completion.pipe(runtime.runPromise)
    expect(imported).toEqual([bytes, bytes])
    const replay = await runtime.runPromise(
      service.startImport({ id, fileId, name: "source.txt" }, bytes)
    )
    await runtime.runPromise(replay.completion)
    expect(Effect.runSync(repository.get(id))).toEqual(saved)
    expect(imported).toHaveLength(2)
  } finally {
    await runtime.dispose()
  }
})
