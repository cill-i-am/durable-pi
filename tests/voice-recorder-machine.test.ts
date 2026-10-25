import { it as effectIt } from "@effect/vitest"
import { createEffectActor, send, waitFor } from "@xstate/effect"
import { Cause, Effect, Exit, Scope } from "effect"
import { TestClock } from "effect/testing"
import { expect, it, vi } from "vitest"

import { fileWorkFailures } from "../src/features/files/owned-work"
import {
  openVoiceCapture,
  type VoicePlatform,
} from "../src/features/files/voice-capture"
import { voiceRecorderMachine } from "../src/features/files/voice-recorder.machine"
import { MAX_FILE_BYTES } from "../src/workspace/files"

function gate<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
class Recorder {
  state = "inactive"
  mimeType = "audio/ogg;codecs=opus"
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null
  held = false
  start = vi.fn(() => {
    this.state = "recording"
  })
  stop = vi.fn(() => {
    this.state = "inactive"
    if (!this.held) queueMicrotask(() => this.stopped())
  })
  stopped() {
    this.ondataavailable?.({
      data: new Blob(["last data"], { type: this.mimeType }),
    })
    this.onstop?.()
  }
}
async function fixture() {
  const permission = gate<MediaStream>(),
    stop = vi.fn(),
    recorder = new Recorder()
  const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream
  const platform = {
    acquire: vi.fn(() => permission.promise),
    recorder: vi.fn(() => recorder as unknown as MediaRecorder),
  } satisfies VoicePlatform
  const uploads: File[] = []
  const scope = await Effect.runPromise(Scope.make())
  const actor = await Effect.runPromise(
    Effect.gen(function* () {
      const observe = yield* fileWorkFailures
      return yield* createEffectActor(
        voiceRecorderMachine({
          open: () => openVoiceCapture(platform, observe),
          upload: (file) =>
            Effect.sync(() => {
              uploads.push(file)
            }),
        })
      )
    }).pipe(Scope.provide(scope))
  )
  const event = (type: "START" | "CANCEL" | "FINISH") =>
    Effect.runPromise(send(actor, { type }))
  const state = (
    value:
      | "idle"
      | "opening"
      | "acquiring"
      | "recording"
      | "finishing"
      | "releasing"
      | "uploading"
      | "blocked"
  ) => vi.waitFor(() => expect(actor.getSnapshot().matches(value)).toBe(true))
  return {
    actor,
    permission,
    platform,
    stream,
    recorder,
    stop,
    uploads,
    event,
    state,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    closeExit: () => Effect.runPromiseExit(Scope.close(scope, Exit.void)),
  }
}

it("keeps cancelled permission acquisition occupied until its late stream is released", async () => {
  const f = await fixture()
  await f.event("START")
  await f.state("acquiring")
  await f.event("CANCEL")
  await f.state("releasing")
  await f.event("START")
  expect(f.platform.acquire).toHaveBeenCalledTimes(1)
  f.permission.resolve(f.stream)
  await f.state("idle")
  expect(f.stop).toHaveBeenCalledTimes(1)
  expect(f.platform.recorder).not.toHaveBeenCalled()
  expect(f.uploads).toEqual([])
  await f.close()
})
it("owner closure retains a compound native defect arriving after microphone cancellation", async () => {
  const f = await fixture()
  await f.event("START")
  await f.state("acquiring")
  let joined = false
  const closing = f.closeExit().then((exit) => {
    joined = true
    return exit
  })
  await new Promise((done) => setTimeout(done, 10))
  expect(joined).toBe(false)
  const defect = new Error("late microphone defect")
  f.permission.reject(
    Cause.fromReasons([
      ...Cause.fail("late checked failure").reasons,
      ...Cause.die(defect).reasons,
      ...Cause.interrupt(78123).reasons,
    ])
  )
  const exit = await closing
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect(exit.cause.reasons).toContainEqual(
      expect.objectContaining({ _tag: "Die", defect })
    )
    expect(exit.cause.reasons).toContainEqual(
      expect.objectContaining({ _tag: "Interrupt", fiberId: 78123 })
    )
    expect(Cause.pretty(exit.cause)).toContain("late checked failure")
  }
})
it("retains final native data and uploads once after joined stop and track release", async () => {
  const f = await fixture()
  f.recorder.held = true
  await f.event("START")
  f.permission.resolve(f.stream)
  await f.state("recording")
  await vi.waitFor(() => expect(f.recorder.start).toHaveBeenCalledTimes(1))
  await f.event("FINISH")
  await f.state("finishing")
  await vi.waitFor(() => expect(f.recorder.stop).toHaveBeenCalledTimes(1))
  expect(f.uploads).toEqual([])
  expect(f.stop).not.toHaveBeenCalled()
  f.recorder.stopped()
  await f.state("idle")
  expect(f.stop).toHaveBeenCalledTimes(1)
  expect(f.uploads).toHaveLength(1)
  expect(f.uploads[0]!.name).toBe("voice-message.ogg")
  expect(await f.uploads[0]!.text()).toBe("last data")
  expect(f.recorder.onstop).toBeNull()
  expect(f.recorder.ondataavailable).toBeNull()
  await f.close()
})
it("owner closure joins late permission and never starts the recorder", async () => {
  const f = await fixture()
  await f.event("START")
  await f.state("acquiring")
  let closed = false
  const close = f.close().then(() => {
    closed = true
  })
  await new Promise((done) => setTimeout(done, 10))
  expect(closed).toBe(false)
  f.permission.resolve(f.stream)
  await close
  expect(f.stop).toHaveBeenCalledTimes(1)
  expect(f.platform.recorder).not.toHaveBeenCalled()
})
it("owner closure joins native stop before releasing listeners and tracks", async () => {
  const f = await fixture()
  f.recorder.held = true
  await f.event("START")
  f.permission.resolve(f.stream)
  await f.state("recording")
  await vi.waitFor(() => expect(f.recorder.start).toHaveBeenCalledTimes(1))
  let closed = false
  const close = f.close().then(() => {
    closed = true
  })
  await vi.waitFor(() => expect(f.recorder.stop).toHaveBeenCalledTimes(1))
  expect(closed).toBe(false)
  expect(f.stop).not.toHaveBeenCalled()
  f.recorder.stopped()
  await close
  expect(f.stop).toHaveBeenCalledTimes(1)
  expect(f.uploads).toEqual([])
  expect(f.recorder.onstop).toBeNull()
})
it("denied microphone is actionable and explicit retry acquires once more", async () => {
  const f = await fixture()
  f.platform.acquire.mockRejectedValueOnce(new Error("Microphone denied"))
  await f.event("START")
  await vi.waitFor(() =>
    expect(f.actor.getSnapshot().context.error).toBe("Microphone denied")
  )
  await f.state("idle")
  await f.event("START")
  await f.state("acquiring")
  expect(f.platform.acquire).toHaveBeenCalledTimes(2)
  f.permission.resolve(f.stream)
  await f.state("recording")
  await f.event("CANCEL")
  await f.state("idle")
  await f.close()
})
it("oversize chunks stop and release capture without uploading", async () => {
  const f = await fixture()
  await f.event("START")
  f.permission.resolve(f.stream)
  await f.state("recording")
  await vi.waitFor(() => expect(f.recorder.start).toHaveBeenCalledTimes(1))
  f.recorder.ondataavailable?.({
    data: new Blob([new Uint8Array(MAX_FILE_BYTES + 1)]),
  })
  await f.state("idle")
  expect(f.actor.getSnapshot().context.error).toContain("exceeded 8 MB")
  expect(f.stop).toHaveBeenCalledTimes(1)
  expect(f.uploads).toEqual([])
  await f.close()
})

it("the next mounted owner waits for the former owner's late stream release", async () => {
  const previous = await fixture(),
    next = await fixture()
  await previous.event("START")
  await previous.state("acquiring")
  const closing = previous.close()
  await next.event("START")
  await next.state("acquiring")
  expect(next.platform.acquire).not.toHaveBeenCalled()
  previous.permission.resolve(previous.stream)
  await closing
  await vi.waitFor(() => expect(next.platform.acquire).toHaveBeenCalledTimes(1))
  expect(previous.stop).toHaveBeenCalledTimes(1)
  await next.event("CANCEL")
  next.permission.resolve(next.stream)
  await next.state("idle")
  expect(next.stop).toHaveBeenCalledTimes(1)
  await next.close()
})

it("one failed track release still stops remaining tracks and blocks reacquisition", async () => {
  const f = await fixture(),
    other = vi.fn()
  f.stream.getTracks = () =>
    [
      {
        stop: () => {
          throw new Error("track release defect")
        },
      },
      { stop: other },
    ] as unknown as MediaStreamTrack[]
  await f.event("START")
  f.permission.resolve(f.stream)
  await f.state("recording")
  await f.event("CANCEL")
  await f.state("blocked")
  expect(other).toHaveBeenCalledTimes(1)
  await f.event("START")
  expect(f.platform.acquire).toHaveBeenCalledTimes(1)
  await expect(f.close()).rejects.toBeDefined()
})

effectIt.effect(
  "ten-minute recording deadline finishes once and cancelled timers cannot finish a later attempt",
  () =>
    Effect.gen(function* () {
      let finishes = 0,
        releases = 0
      const actor = yield* createEffectActor(
        voiceRecorderMachine({
          open: () =>
            Effect.succeed({
              ready: Effect.void,
              record: Effect.never,
              finish: Effect.sync(() => {
                finishes++
                return null
              }),
              close: Effect.sync(() => {
                releases++
              }),
            }),
          upload: () => Effect.die("No upload expected"),
        })
      )
      yield* send(actor, { type: "START" })
      yield* waitFor(actor, (s) => s.matches("recording"))
      yield* TestClock.adjust("10 minutes")
      yield* waitFor(actor, (s) => s.matches("idle"))
      expect(finishes).toBe(1)
      expect(releases).toBe(1)
      yield* send(actor, { type: "START" })
      yield* waitFor(actor, (s) => s.matches("recording"))
      yield* send(actor, { type: "CANCEL" })
      yield* waitFor(actor, (s) => s.matches("idle"))
      yield* TestClock.adjust("10 minutes")
      expect(finishes).toBe(1)
      expect(releases).toBe(2)
    }).pipe(Effect.scoped)
)
