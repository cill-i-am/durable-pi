import { createEffectActor, send } from "@xstate/effect"
import { Cause, Effect, Exit, Scope } from "effect"
import { expect, it, vi } from "vitest"
import { initialTransition, transition } from "xstate"

import { fileDetailsMachine } from "../src/features/files/file-details.machine"
import { readFilePreview } from "../src/features/files/file-preview-resource"
import {
  filePreviewMachine,
  type PreviewResource,
} from "../src/features/files/file-preview.machine"
import { fileWorkFailures } from "../src/features/files/owned-work"
import { nativeOperation } from "../src/shared/interop"

const resource = (key: string, eager = true): PreviewResource => ({
  key,
  agentId: key,
  fileId: "file",
  kind: "text",
  eager,
})

it("malformed resource and mutation events cannot dispatch work", () => {
  const preview = filePreviewMachine(() => Effect.never)
  const [state] = initialTransition(preview, resource("alpha", false))
  const [unchanged, effects] = transition(preview, state, {
    type: "RESOURCE",
    ...resource("beta"),
    agentId: 4,
  } as never)
  expect(unchanged).toBe(state)
  expect(effects).toMatchObject([
    { type: "@xstate.deadLetter", reason: "invalidEvent" },
  ])
  const details = fileDetailsMachine(() => Effect.never)
  const [idle] = initialTransition(details, { name: "file" })
  const [same, rejected] = transition(details, idle, {
    type: "SUBMIT",
    action: "unexpected",
  } as never)
  expect(same).toBe(idle)
  expect(rejected).toMatchObject([
    { type: "@xstate.deadLetter", reason: "invalidEvent" },
  ])
})
it("a replaced resource aborts the old request and cannot publish its late completion", async () => {
  const requests: { key: string; signal: AbortSignal; release: () => void }[] =
    []
  const scope = await Effect.runPromise(Scope.make())
  const actor = await Effect.runPromise(
    createEffectActor(
      filePreviewMachine((input) =>
        nativeOperation(
          (signal) =>
            new Promise<{ text: string }>((resolve) => {
              requests.push({
                key: input.key,
                signal,
                release: () => resolve({ text: input.key }),
              })
            }),
          (cause) => cause
        )
      ),
      { input: resource("alpha") }
    ).pipe(Scope.provide(scope))
  )
  await vi.waitFor(() => expect(requests).toHaveLength(1))
  await Effect.runPromise(
    send(actor, { type: "RESOURCE", ...resource("beta") })
  )
  await vi.waitFor(() => expect(requests).toHaveLength(2))
  expect(requests[0]!.signal.aborted).toBe(true)
  requests[1]!.release()
  await vi.waitFor(() =>
    expect(actor.getSnapshot().context.value).toEqual({ text: "beta" })
  )
  requests[0]!.release()
  await new Promise((done) => setTimeout(done, 10))
  expect(actor.getSnapshot().context.value).toEqual({ text: "beta" })
  await Effect.runPromise(Scope.close(scope, Exit.void))
})
it("closed transcript suppresses duplicate opens and owner closure joins its aborted request", async () => {
  let release!: () => void, signal!: AbortSignal
  const read = vi.fn(() =>
    nativeOperation(
      (value) => {
        signal = value
        return new Promise<{ text: string }>((resolve) => {
          release = () => resolve({ text: "late" })
        })
      },
      (cause) => cause
    )
  )
  const scope = await Effect.runPromise(Scope.make())
  const actor = await Effect.runPromise(
    createEffectActor(filePreviewMachine(read), {
      input: resource("alpha", false),
    }).pipe(Scope.provide(scope))
  )
  await Effect.runPromise(send(actor, { type: "OPEN" }))
  await Effect.runPromise(send(actor, { type: "OPEN" }))
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  let closed = false
  const closing = Effect.runPromise(Scope.close(scope, Exit.void)).then(() => {
    closed = true
  })
  await vi.waitFor(() => expect(signal.aborted).toBe(true))
  expect(closed).toBe(false)
  release()
  await closing
})
it("a transcript uses at most two progressing pages and preserves checked failures", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ text: "first", next: 12 }))
    .mockResolvedValueOnce(Response.json({ text: "second", next: 24 }))
  vi.stubGlobal("fetch", fetch)
  try {
    const result = await Effect.runPromiseExit(
      readFilePreview({ ...resource("alpha"), kind: "transcript" })
    )
    expect(result._tag).toBe("Failure")
    expect(fetch).toHaveBeenCalledTimes(2)
  } finally {
    vi.unstubAllGlobals()
  }
})
it("preview closure reports the complete late native Cause after abort and join", async () => {
  let reject!: (cause: unknown) => void, signal!: AbortSignal
  vi.stubGlobal(
    "fetch",
    vi.fn((_url, options) => {
      signal = options.signal
      return new Promise((_resolve, fail) => {
        reject = fail
      })
    })
  )
  const scope = await Effect.runPromise(Scope.make())
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const observe = yield* fileWorkFailures
        return yield* createEffectActor(
          filePreviewMachine((input) => observe(readFilePreview(input))),
          { input: resource("alpha") }
        )
      }).pipe(Scope.provide(scope))
    )
    await vi.waitFor(() => expect(reject).toBeDefined())
    let joined = false
    const closing = Effect.runPromiseExit(Scope.close(scope, Exit.void)).then(
      (exit) => {
        joined = true
        return exit
      }
    )
    await vi.waitFor(() => expect(signal.aborted).toBe(true))
    expect(joined).toBe(false)
    const defect = new Error("late preview defect")
    reject(
      Cause.fromReasons([
        ...Cause.fail("late preview fault").reasons,
        ...Cause.die(defect).reasons,
        ...Cause.interrupt(79123).reasons,
      ])
    )
    const exit = await closing
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons).toContainEqual(
        expect.objectContaining({ _tag: "Die", defect })
      )
      expect(exit.cause.reasons).toContainEqual(
        expect.objectContaining({ _tag: "Interrupt", fiberId: 79123 })
      )
      expect(Cause.pretty(exit.cause)).toContain("late preview fault")
    }
  } finally {
    vi.unstubAllGlobals()
  }
})
it("rename retains its immutable submitted name and stays editing after rejection", async () => {
  let release!: (accepted: boolean) => void
  const inputs: unknown[] = []
  const scope = await Effect.runPromise(Scope.make())
  const actor = await Effect.runPromise(
    createEffectActor(
      fileDetailsMachine((input) =>
        nativeOperation(
          () => {
            inputs.push(input)
            return new Promise<boolean>((resolve) => {
              release = resolve
            })
          },
          (cause) => cause
        )
      ),
      { input: { name: "original" } }
    ).pipe(Scope.provide(scope))
  )
  await Effect.runPromise(send(actor, { type: "SUBMIT", action: "rename" }))
  expect(inputs).toEqual([])
  await Effect.runPromise(send(actor, { type: "EDIT", name: "original" }))
  await Effect.runPromise(send(actor, { type: "NAME", name: " renamed " }))
  await Effect.runPromise(send(actor, { type: "SUBMIT", action: "rename" }))
  await vi.waitFor(() =>
    expect(inputs).toEqual([{ action: "rename", name: "renamed" }])
  )
  await Effect.runPromise(send(actor, { type: "NAME", name: "stale" }))
  await Effect.runPromise(send(actor, { type: "SUBMIT", action: "trash" }))
  expect(inputs).toHaveLength(1)
  release(false)
  await vi.waitFor(() =>
    expect(actor.getSnapshot().matches("editing")).toBe(true)
  )
  expect(actor.getSnapshot().context.name).toBe("renamed")
  await Effect.runPromise(Scope.close(scope, Exit.void))
})
