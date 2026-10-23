import { Cause, Context, Effect, Layer, ManagedRuntime } from "effect"
import { expect, it, vi } from "vitest"

vi.mock("@cloudflare/sandbox", () => ({ Files: class {} }))
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  env: {},
  tracing: undefined,
}))

import { nativeOperation } from "../src/shared/interop"
import { LinuxSandboxV1 } from "../src/terminal/adapters/native-worker"
import { NativeTerminalHost } from "../src/terminal/native-host"
import {
  advanceNativeHostImport,
  initialNativeHostImport,
  type NativeImportIdentity,
} from "../src/terminal/native-host.machine"

const receipt = {
  owner: "owner",
  name: "video-test",
  key: "manifest",
  sha256: "hash",
  size: 10,
}
const result = { verified: true, sha256: "hash", counts: {} }
function gate<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function fixture(
  importing = vi.fn(async (_receipt: NativeImportIdentity) => result)
) {
  let phase = "original"
  let persisted: NativeImportIdentity | undefined
  const transportHost = new NativeTerminalHost({
    runExit: Effect.runPromiseExit,
    writable: () => phase === "original" || phase === "done",
    receipt: () => persisted,
    import: importing,
  })
  return {
    transportHost,
    importing,
    phase: (value: string) => {
      phase = value
    },
    persisted: (value: NativeImportIdentity) => {
      persisted = value
    },
  }
}
const signal = () => new AbortController().signal
const video = Effect.succeed(new Response("video"))
it("actual native host rejects video while migration is frozen", async () => {
  const extract = vi.fn(() =>
    Effect.succeed({
      duration: 1,
      frames: [{ at: 0, jpeg: "synthetic" }],
      captions: "",
      captionsTruncated: false,
    })
  )
  const f = fixture()
  f.phase("copying")
  const host = {
    transportHost: f.transportHost,
    extractVideo: extract,
    ctx: { waitUntil: vi.fn() },
  }
  const response = await Reflect.apply(LinuxSandboxV1.prototype.fetch, host, [
    new Request("https://terminal.internal/video", {
      method: "POST",
      body: new Uint8Array([1]),
    }),
  ])
  expect(response.status).toBe(503)
  expect(extract).not.toHaveBeenCalled()
  expect(host.ctx.waitUntil).toHaveBeenCalledOnce()
})
it("actual native host rejects changed immutable receipt while import is held", async () => {
  const held = gate<typeof result>()
  const f = fixture(vi.fn(() => held.promise))
  const host = {
    env: { SANDBOX: { idFromName: () => "native-id" } },
    ctx: { id: "native-id", waitUntil: vi.fn() },
    transportHost: f.transportHost,
  }
  const first = Reflect.apply(LinuxSandboxV1.prototype.importMigration, host, [
    receipt,
  ])
  const same = Reflect.apply(LinuxSandboxV1.prototype.importMigration, host, [
    { ...receipt },
  ])
  const second = Reflect.apply(LinuxSandboxV1.prototype.importMigration, host, [
    { ...receipt, key: "different", size: 99 },
  ])
  expect(same).toBe(first)
  const settled = Promise.allSettled([first, second])
  held.resolve(result)
  const outcomes = await settled
  expect(outcomes[0]).toEqual({ status: "fulfilled", value: result })
  expect(outcomes[1]).toMatchObject({
    status: "rejected",
    reason: new Error("Conflicting terminal migration"),
  })
  expect(f.importing).toHaveBeenCalledTimes(1)
  expect(host.ctx.waitUntil).toHaveBeenCalledWith(first)
})

it.each(["owner", "name", "key", "sha256", "size"] as const)(
  "rejects active or restored import with changed %s",
  async (field) => {
    const changed = { ...receipt, [field]: field === "size" ? 99 : "different" }
    const held = gate<typeof result>()
    const f = fixture(vi.fn(() => held.promise))
    const pending = f.transportHost.import(receipt)
    await expect(f.transportHost.import(changed)).rejects.toThrow(
      "Conflicting terminal migration"
    )
    held.resolve(result)
    await pending
    for (const phase of ["copying", "done"]) {
      const restored = fixture()
      restored.phase(phase)
      restored.persisted({ ...receipt })
      await expect(restored.transportHost.import(changed)).rejects.toThrow(
        "Conflicting terminal migration"
      )
      expect(restored.importing).not.toHaveBeenCalled()
      await expect(
        restored.transportHost.import({ ...receipt })
      ).resolves.toEqual(result)
      expect(restored.importing).toHaveBeenCalledOnce()
    }
  }
)

it("copies receipt before held admission and freezes video before native dispatch", async () => {
  const admitted = gate<void>(),
    release = gate<void>(),
    native = gate<typeof result>()
  const importing = vi.fn((_receipt: NativeImportIdentity) => native.promise)
  const host = new NativeTerminalHost({
    runExit: async <T, E>(
      work: Effect.Effect<T, E>,
      options?: { signal?: AbortSignal }
    ) => {
      admitted.resolve()
      await release.promise
      return Effect.runPromiseExit(work, options)
    },
    writable: () => true,
    receipt: () => undefined,
    import: importing,
  })
  const mutable = { ...receipt }
  const pending = host.import(mutable)
  const same = host.import({ ...receipt })
  mutable.key = "mutated"
  mutable.size = 99
  await admitted.promise
  expect((await host.video(video, signal())).status).toBe(503)
  expect(same).toBe(pending)
  expect(importing).not.toHaveBeenCalled()
  release.resolve()
  await vi.waitFor(() => expect(importing).toHaveBeenCalledOnce())
  expect(importing.mock.calls[0]).toEqual([receipt])
  expect(Object.isFrozen(importing.mock.calls[0]?.[0])).toBe(true)
  expect((await host.video(video, signal())).status).toBe(503)
  native.resolve(result)
  await pending
  expect((await host.video(video, signal())).status).toBe(200)
})

it.each([
  "original",
  "frozen",
  "sealed",
  "snapshot",
  "copying",
  "done",
  "moved",
])("reads current ledger phase %s for video admission", async (phase) => {
  const f = fixture()
  f.phase(phase)
  const extract = vi.fn(() => new Response("video"))
  const response = await f.transportHost.video(Effect.sync(extract), signal())
  const permitted = phase === "original" || phase === "done"
  expect(response.status).toBe(permitted ? 200 : 503)
  expect(extract).toHaveBeenCalledTimes(permitted ? 1 : 0)
})

it("joins video finalizers before starting a reserved import and reopens from the ledger", async () => {
  const closing = gate<void>(),
    closed = gate<void>(),
    native = gate<typeof result>()
  const f = fixture(vi.fn(() => native.promise))
  const pendingVideo = f.transportHost.video(
    video.pipe(
      Effect.ensuring(
        Effect.promise(() => {
          closing.resolve()
          return closed.promise
        })
      )
    ),
    signal()
  )
  await closing.promise
  const pendingImport = f.transportHost.import(receipt)
  expect(f.transportHost.import({ ...receipt })).toBe(pendingImport)
  expect((await f.transportHost.video(video, signal())).status).toBe(503)
  expect(f.importing).not.toHaveBeenCalled()
  closed.resolve()
  await pendingVideo
  await vi.waitFor(() => expect(f.importing).toHaveBeenCalledOnce())
  f.phase("copying")
  native.resolve(result)
  await pendingImport
  expect((await f.transportHost.video(video, signal())).status).toBe(503)
  f.phase("done")
  expect((await f.transportHost.video(video, signal())).status).toBe(200)
})

it("retains video admission through abort until native cleanup is joined", async () => {
  const started = gate<void>(),
    native = gate<void>(),
    closing = gate<void>(),
    closed = gate<void>()
  const f = fixture()
  const abort = new AbortController()
  let complete = false
  const pending = f.transportHost
    .video(
      nativeOperation(
        () => {
          started.resolve()
          return native.promise
        },
        (cause) => cause
      ).pipe(
        Effect.as(new Response("video")),
        Effect.ensuring(
          Effect.promise(() => {
            closing.resolve()
            return closed.promise
          })
        )
      ),
      abort.signal
    )
    .finally(() => {
      complete = true
    })
  const settled = Promise.allSettled([pending])
  await started.promise
  abort.abort()
  expect((await f.transportHost.video(video, signal())).status).toBe(503)
  expect(complete).toBe(false)
  native.resolve()
  await closing.promise
  expect((await f.transportHost.video(video, signal())).status).toBe(503)
  expect(complete).toBe(false)
  closed.resolve()
  expect((await settled)[0]?.status).toBe("rejected")
  expect((await f.transportHost.video(video, signal())).status).toBe(200)
})

it("preserves compound video failure through joined cleanup and prevents the waiting import", async () => {
  class Annotation extends Context.Service<Annotation, string>()(
    "native-host-test/annotation"
  ) {}
  const checked = new Error("checked teardown"),
    defect = new Error("native teardown defect")
  const cause = Cause.fromReasons([
    Cause.makeFailReason(checked).annotate(Context.make(Annotation, "checked")),
    Cause.makeDieReason(defect).annotate(Context.make(Annotation, "defect")),
  ])
  const closing = gate<void>(),
    closed = gate<void>()
  const runtime = ManagedRuntime.make(Layer.empty)
  const importing = vi.fn(async () => result)
  const host = new NativeTerminalHost({
    runExit: <T, E>(
      work: Effect.Effect<T, E>,
      options?: { signal?: AbortSignal }
    ) => runtime.runPromiseExit(work, options),
    writable: () => true,
    receipt: () => undefined,
    import: importing,
  })
  try {
    const pendingVideo = host.video(
      Effect.failCause(cause).pipe(
        Effect.ensuring(
          Effect.promise(() => {
            closing.resolve()
            return closed.promise
          })
        )
      ),
      signal()
    )
    const videoExit = pendingVideo.catch((error: unknown) => error)
    await closing.promise
    const pendingImport = host.import(receipt)
    const importExit = pendingImport.catch((error: unknown) => error)
    expect((await host.video(video, signal())).status).toBe(503)
    closed.resolve()
    for (const failure of [await videoExit, await importExit]) {
      expect(Cause.isCause(failure)).toBe(true)
      if (!Cause.isCause(failure)) throw new Error("missing complete Cause")
      expect(
        failure.reasons.map((reason) => ({
          tag: reason._tag,
          value:
            reason._tag === "Fail"
              ? reason.error
              : reason._tag === "Die"
                ? reason.defect
                : undefined,
          annotation: reason.annotations.get(Annotation.key),
        }))
      ).toEqual([
        { tag: "Fail", value: checked, annotation: "checked" },
        { tag: "Die", value: defect, annotation: "defect" },
      ])
    }
    expect(importing).not.toHaveBeenCalled()
  } finally {
    await runtime.dispose()
  }
})

it("shares genuine import settlement and preserves full native rejection through ManagedRuntime", async () => {
  class Annotation extends Context.Service<Annotation, string>()(
    "native-host-test/import-annotation"
  ) {}
  const cause = Cause.fromReasons([
    Cause.makeFailReason("checked import").annotate(
      Context.make(Annotation, "checked")
    ),
    Cause.makeDieReason("late import defect").annotate(
      Context.make(Annotation, "defect")
    ),
  ])
  const started = gate<void>(),
    native = gate<typeof result>()
  const runtime = ManagedRuntime.make(Layer.empty)
  const importing = vi.fn(() => {
    started.resolve()
    return native.promise
  })
  const host = new NativeTerminalHost({
    runExit: <T, E>(
      work: Effect.Effect<T, E>,
      options?: { signal?: AbortSignal }
    ) => runtime.runPromiseExit(work, options),
    writable: () => true,
    receipt: () => undefined,
    import: importing,
  })
  try {
    const pending = host.import(receipt)
    const failure = pending.catch((error: unknown) => error)
    await started.promise
    expect(host.import({ ...receipt })).toBe(pending)
    expect((await host.video(video, signal())).status).toBe(503)
    native.reject(cause)
    const received = await failure
    expect(
      Cause.isCause(received) &&
        received.reasons.map((reason) => ({
          tag: reason._tag,
          value:
            reason._tag === "Fail"
              ? reason.error
              : reason._tag === "Die"
                ? reason.defect
                : undefined,
          annotation: reason.annotations.get(Annotation.key),
        }))
    ).toEqual([
      { tag: "Fail", value: "checked import", annotation: "checked" },
      { tag: "Die", value: "late import defect", annotation: "defect" },
    ])
    expect(importing).toHaveBeenCalledOnce()
    expect((await host.video(video, signal())).status).toBe(200)
  } finally {
    await runtime.dispose()
  }
})

it("ignores stale import join events while a replacement owns admission", () => {
  let state = initialNativeHostImport()
  state = advanceNativeHostImport(state, {
    type: "IMPORT",
    token: "old",
    receipt,
    persisted: null,
  })
  state = advanceNativeHostImport(state, { type: "JOINED", token: "old" })
  state = advanceNativeHostImport(state, {
    type: "IMPORT",
    token: "new",
    receipt,
    persisted: null,
  })
  state = advanceNativeHostImport(state, { type: "JOINED", token: "old" })
  expect(state.context.token).toBe("new")
  expect(state.matches("importing")).toBe(true)
})

it("holds video reservation when cancellation arrives before runner admission", async () => {
  const admitted = gate<void>(),
    release = gate<void>()
  const abort = new AbortController()
  const started = vi.fn(() => new Response("video"))
  const host = new NativeTerminalHost({
    runExit: async <T, E>(
      work: Effect.Effect<T, E>,
      options?: { signal?: AbortSignal }
    ) => {
      admitted.resolve()
      await release.promise
      return Effect.runPromiseExit(work, options)
    },
    writable: () => true,
    receipt: () => undefined,
    import: async () => result,
  })
  const pending = host.video(Effect.sync(started), abort.signal)
  const settled = Promise.allSettled([pending])
  await admitted.promise
  abort.abort()
  expect((await host.video(video, signal())).status).toBe(503)
  expect(started).not.toHaveBeenCalled()
  release.resolve()
  expect((await settled)[0]?.status).toBe("rejected")
  expect(started).not.toHaveBeenCalled()
  expect((await host.video(video, signal())).status).toBe(200)
})

it("joins a cancelled native import and retains its late annotated fatal failure", async () => {
  class Annotation extends Context.Service<Annotation, string>()(
    "native-host-test/cancel-annotation"
  ) {}
  const checked = Cause.makeFailReason("late checked import").annotate(
    Context.make(Annotation, "checked")
  )
  const defect = Cause.makeDieReason("late fatal import").annotate(
    Context.make(Annotation, "defect")
  )
  const cause = Cause.fromReasons([checked, defect])
  const started = gate<void>(),
    native = gate<typeof result>()
  const abort = new AbortController()
  const runtime = ManagedRuntime.make(Layer.empty)
  const importing = vi.fn(() => {
    started.resolve()
    return native.promise
  })
  const host = new NativeTerminalHost({
    runExit: <T, E>(work: Effect.Effect<T, E>) =>
      runtime.runPromiseExit(work, { signal: abort.signal }),
    writable: () => true,
    receipt: () => undefined,
    import: importing,
  })
  try {
    let complete = false
    const pending = host.import(receipt)
    const failure = pending.catch((error: unknown) => {
      complete = true
      return error
    })
    await started.promise
    abort.abort()
    expect(host.import({ ...receipt })).toBe(pending)
    expect((await host.video(video, signal())).status).toBe(503)
    expect(complete).toBe(false)
    native.reject(cause)
    const received = await failure
    expect(Cause.isCause(received)).toBe(true)
    if (!Cause.isCause(received))
      throw new Error("missing cancelled import Cause")
    expect(received.reasons.some((reason) => reason._tag === "Interrupt")).toBe(
      true
    )
    expect(
      received.reasons.some(
        (reason) =>
          reason._tag === "Die" &&
          reason.defect === "late fatal import" &&
          reason.annotations.get(Annotation.key) === "defect"
      )
    ).toBe(true)
    expect(
      received.reasons.some(
        (reason) =>
          reason._tag === "Die" &&
          Cause.isReason(reason.defect) &&
          reason.defect._tag === "Fail" &&
          reason.defect.error === "late checked import" &&
          reason.defect.annotations.get(Annotation.key) === "checked"
      )
    ).toBe(true)
    expect(importing).toHaveBeenCalledOnce()
  } finally {
    await runtime.dispose()
  }
})

it("rejects a malformed import receipt before any native work", async () => {
  const f = fixture()
  const malformed = { ...receipt, size: "10" }
  const result = await Promise.resolve()
    .then(() =>
      Reflect.apply(f.transportHost.import, f.transportHost, [malformed])
    )
    .then(
      () => "accepted",
      () => "rejected"
    )
  expect(result).toBe("rejected")
  expect(f.importing).not.toHaveBeenCalled()
})
