import { afterEach, expect, test, vi } from "vitest"

const lifecycle = vi.hoisted(() => ({
  cleanup: undefined as (() => void) | undefined,
}))
vi.mock("react", () => ({
  useRef: <T>(value: T) => ({ current: value }),
  useEffect: (start: () => (() => void) | undefined) => {
    lifecycle.cleanup = start()
  },
}))

import { useInteractionSound } from "../src/hooks/use-interaction-sound"

afterEach(() => {
  lifecycle.cleanup?.()
  lifecycle.cleanup = undefined
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test("disconnects the acquired oscillator when gain acquisition fails", async () => {
  const disconnect = vi.fn()
  class Audio {
    state = "running"
    createOscillator = () => ({ disconnect })
    createGain = () => {
      throw new Error("gain unavailable")
    }
    close = async () => {}
  }
  vi.stubGlobal("window", {
    AudioContext: Audio,
    localStorage: { getItem: () => null },
  })
  vi.stubGlobal("AudioContext", Audio)
  await useInteractionSound()()
  expect(disconnect).toHaveBeenCalledTimes(1)
})

import { it } from "@effect/vitest"
import { createEffectActor, send, waitFor } from "@xstate/effect"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"

import {
  makeInteractionSoundResource,
  playInteractionTone,
} from "../src/hooks/interaction-sound-resource"
import { interactionSoundMachine } from "../src/hooks/interaction-sound.machine"

const promiseGate = () => {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function fakeAudio(failure?: string) {
  const calls: string[] = []
  const listeners = new Set<() => void>()
  const record = (name: string) => {
    calls.push(name)
    if (failure === name) throw new Error(name)
  }
  let onStarted = () => {}
  let onResuming = () => {}
  let onClosing = () => {}
  let resume = async () => {}
  let close = async () => {}
  const audio = {
    state: "running",
    currentTime: 4,
    destination: {},
    createOscillator() {
      record("oscillator")
      return {
        type: "sine",
        frequency: {
          setValueAtTime: () => record("frequency"),
          exponentialRampToValueAtTime: () => record("frequencyRamp"),
        },
        connect: () => record("oscillatorConnect"),
        disconnect: () => record("oscillatorDisconnect"),
        addEventListener: (_: string, listener: () => void) => {
          record("listen")
          listeners.add(listener)
        },
        removeEventListener: (_: string, listener: () => void) => {
          record("unlisten")
          listeners.delete(listener)
        },
        start: () => {
          record("start")
          queueMicrotask(() => onStarted())
        },
        stop: (when?: number) =>
          record(when === undefined ? "cancelTone" : "scheduleStop"),
      }
    },
    createGain() {
      record("gain")
      return {
        gain: {
          setValueAtTime: () => record("gainValue"),
          exponentialRampToValueAtTime: () => record("gainRamp"),
        },
        connect: () => record("gainConnect"),
        disconnect: () => record("gainDisconnect"),
      }
    },
    resume: async () => {
      record("resume")
      queueMicrotask(() => onResuming())
      await resume()
      audio.state = "running"
    },
    close: async () => {
      record("close")
      queueMicrotask(() => onClosing())
      await close()
      audio.state = "closed"
    },
  }
  return {
    audio: audio as unknown as AudioContext,
    calls,
    listeners,
    state: (state: string) => {
      audio.state = state
    },
    holdResume: (work: () => Promise<void>, entered: () => void) => {
      resume = work
      onResuming = entered
    },
    holdClose: (work: () => Promise<void>, entered: () => void) => {
      close = work
      onClosing = entered
    },
    started: (listener: () => void) => {
      onStarted = listener
    },
    finish: () => {
      for (const listener of [...listeners]) listener()
    },
  }
}

for (const failure of [
  "gain",
  "listen",
  "frequency",
  "frequencyRamp",
  "gainValue",
  "gainRamp",
  "oscillatorConnect",
  "gainConnect",
  "start",
  "scheduleStop",
]) {
  it.effect(`releases every acquired node after ${failure} fails`, () =>
    Effect.gen(function* () {
      const fake = fakeAudio(failure)
      const result = yield* playInteractionTone(fake.audio).pipe(
        Effect.scoped,
        Effect.exit
      )
      expect(Exit.isFailure(result)).toBe(true)
      expect(
        fake.calls.filter((call) => call === "oscillatorDisconnect")
      ).toHaveLength(1)
      expect(
        fake.calls.filter((call) => call === "gainDisconnect")
      ).toHaveLength(failure === "gain" ? 0 : 1)
      expect(fake.listeners.size).toBe(0)
      expect(fake.calls.includes("cancelTone")).toBe(failure === "scheduleStop")
    })
  )
}

it.effect(
  "releases tones on completion while retaining the context for overlapping clicks",
  () =>
    Effect.gen(function* () {
      const fake = fakeAudio()
      const started = yield* Deferred.make<void>()
      let starts = 0
      let acquisitions = 0
      fake.started(() => {
        if (++starts === 2) Deferred.doneUnsafe(started, Effect.void)
      })
      const scope = yield* Scope.make()
      const resource = yield* makeInteractionSoundResource(
        () => {
          acquisitions++
          return fake.audio
        },
        () => true
      ).pipe(Effect.provideService(Scope.Scope, scope))
      const first = yield* resource.play().pipe(Effect.forkChild)
      const second = yield* resource.play().pipe(Effect.forkChild)
      yield* Deferred.await(started)
      expect(acquisitions).toBe(1)
      expect(fake.listeners.size).toBe(2)
      fake.finish()
      expect(Exit.isSuccess(yield* Fiber.join(first))).toBe(true)
      expect(Exit.isSuccess(yield* Fiber.join(second))).toBe(true)
      expect(fake.listeners.size).toBe(0)
      expect(
        fake.calls.filter((call) => call === "oscillatorDisconnect")
      ).toHaveLength(2)
      expect(fake.calls).not.toContain("close")
      yield* Scope.close(scope, Exit.void)
      expect(fake.calls.filter((call) => call === "close")).toHaveLength(1)
    })
)

it.effect("mute prevents acquisition and a preview bypasses mute", () =>
  Effect.gen(function* () {
    const fake = fakeAudio()
    let acquisitions = 0
    const started = yield* Deferred.make<void>()
    fake.started(() => Deferred.doneUnsafe(started, Effect.void))
    const scope = yield* Scope.make()
    const resource = yield* makeInteractionSoundResource(
      () => {
        acquisitions++
        return fake.audio
      },
      () => false
    ).pipe(Effect.provideService(Scope.Scope, scope))
    yield* resource.play()
    expect(acquisitions).toBe(0)
    const preview = yield* resource.play(true).pipe(Effect.forkChild)
    yield* Deferred.await(started)
    fake.finish()
    yield* Fiber.join(preview)
    expect(acquisitions).toBe(1)
    yield* Scope.close(scope, Exit.void)
  })
)

it.effect("two pending resumes share a context and both clicks can play", () =>
  Effect.gen(function* () {
    const fake = fakeAudio()
    fake.state("suspended")
    const resume = promiseGate()
    const resuming = yield* Deferred.make<void>()
    const started = yield* Deferred.make<void>()
    let resumes = 0
    let starts = 0
    let acquisitions = 0
    fake.holdResume(
      () => resume.promise,
      () => {
        if (++resumes === 2) Deferred.doneUnsafe(resuming, Effect.void)
      }
    )
    fake.started(() => {
      if (++starts === 2) Deferred.doneUnsafe(started, Effect.void)
    })
    const scope = yield* Scope.make()
    const resource = yield* makeInteractionSoundResource(
      () => {
        acquisitions++
        return fake.audio
      },
      () => true
    ).pipe(Effect.provideService(Scope.Scope, scope))
    const first = yield* resource.play().pipe(Effect.forkChild)
    const second = yield* resource.play().pipe(Effect.forkChild)
    yield* Deferred.await(resuming)
    resume.release()
    yield* Deferred.await(started)
    expect(acquisitions).toBe(1)
    fake.finish()
    yield* Fiber.join(first)
    yield* Fiber.join(second)
    yield* Scope.close(scope, Exit.void)
  })
)

it.effect("a mute change during resume suppresses ordinary playback", () =>
  Effect.gen(function* () {
    const fake = fakeAudio()
    fake.state("suspended")
    let enabled = true
    const resume = promiseGate()
    const entered = yield* Deferred.make<void>()
    fake.holdResume(
      () => resume.promise,
      () => Deferred.doneUnsafe(entered, Effect.void)
    )
    const scope = yield* Scope.make()
    const resource = yield* makeInteractionSoundResource(
      () => fake.audio,
      () => enabled
    ).pipe(Effect.provideService(Scope.Scope, scope))
    const playing = yield* resource.play().pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    enabled = false
    resume.release()
    yield* Fiber.join(playing)
    expect(fake.calls).not.toContain("oscillator")
    yield* Scope.close(scope, Exit.void)
  })
)

it.effect(
  "shutdown fences held resume, closes immediately, and joins native close",
  () =>
    Effect.gen(function* () {
      const fake = fakeAudio()
      fake.state("suspended")
      const resume = promiseGate()
      const closing = promiseGate()
      const resuming = yield* Deferred.make<void>()
      const closeEntered = yield* Deferred.make<void>()
      fake.holdResume(
        () => resume.promise,
        () => Deferred.doneUnsafe(resuming, Effect.void)
      )
      fake.holdClose(
        () => closing.promise,
        () => Deferred.doneUnsafe(closeEntered, Effect.void)
      )
      const scope = yield* Scope.make()
      const resource = yield* makeInteractionSoundResource(
        () => fake.audio,
        () => true
      ).pipe(Effect.provideService(Scope.Scope, scope))
      yield* resource.play().pipe(Effect.forkChild)
      yield* Deferred.await(resuming)
      const closed = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild)
      yield* Deferred.await(closeEntered)
      expect(closed.pollUnsafe()).toBeUndefined()
      resume.release()
      closing.release()
      yield* Fiber.join(closed)
      yield* Effect.yieldNow
      expect(fake.calls).not.toContain("oscillator")
      expect(fake.calls.filter((call) => call === "close")).toHaveLength(1)
      yield* resource.play().pipe(Effect.exit)
      expect(fake.calls).not.toContain("oscillator")
    })
)

it.effect(
  "unmount stops and disconnects playing tones before context closure",
  () =>
    Effect.gen(function* () {
      const fake = fakeAudio()
      const started = yield* Deferred.make<void>()
      fake.started(() => Deferred.doneUnsafe(started, Effect.void))
      const scope = yield* Scope.make()
      const resource = yield* makeInteractionSoundResource(
        () => fake.audio,
        () => true
      ).pipe(Effect.provideService(Scope.Scope, scope))
      yield* resource.play().pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Scope.close(scope, Exit.void)
      expect(fake.calls).toContain("cancelTone")
      expect(fake.listeners.size).toBe(0)
      expect(fake.calls.indexOf("oscillatorDisconnect")).toBeLessThan(
        fake.calls.indexOf("close")
      )
      fake.finish()
      expect(fake.calls.filter((call) => call === "start")).toHaveLength(1)
    })
)

it.effect(
  "constructor and unavailable-audio failures leave later explicit attempts available",
  () =>
    Effect.gen(function* () {
      let calls = 0
      const resource = yield* makeInteractionSoundResource(
        () => {
          if (++calls === 1) throw new Error("audio blocked")
          return null
        },
        () => true
      )
      expect(Exit.isFailure(yield* resource.play())).toBe(true)
      expect(Exit.isSuccess(yield* resource.play())).toBe(true)
      expect(calls).toBe(2)
    }).pipe(Effect.scoped)
)

it.effect("rejects malformed play events before audio acquisition", () =>
  Effect.gen(function* () {
    let acquisitions = 0
    const actor = yield* createEffectActor(
      interactionSoundMachine({
        enabled: () => true,
        acquire: Effect.sync(() => {
          acquisitions++
          return null
        }),
      })
    )
    yield* send(actor, { type: "PLAY", preview: "yes" } as unknown as {
      type: "PLAY"
      preview: boolean
    })
    yield* Effect.yieldNow
    expect(actor.getSnapshot().matches("idle")).toBe(true)
    expect(acquisitions).toBe(0)
    yield* send(actor, { type: "PLAY", preview: true })
    yield* waitFor(actor, (state) => state.matches("suppressed"))
    expect(acquisitions).toBe(1)
  }).pipe(Effect.scoped)
)

it.effect(
  "retains node cleanup failure after the request actor is interrupted",
  () =>
    Effect.gen(function* () {
      const fake = fakeAudio("gainDisconnect")
      const started = yield* Deferred.make<void>()
      fake.started(() => Deferred.doneUnsafe(started, Effect.void))
      const scope = yield* Scope.make()
      const resource = yield* makeInteractionSoundResource(
        () => fake.audio,
        () => true
      ).pipe(Effect.provideService(Scope.Scope, scope))
      yield* resource.play().pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const closed = yield* Scope.close(scope, Exit.void).pipe(Effect.exit)
      expect(Exit.isFailure(closed)).toBe(true)
      expect(fake.calls).toContain("oscillatorDisconnect")
      expect(fake.calls).toContain("close")
    })
)

it.effect(
  "context-close rejection remains observable after the cleanup barrier",
  () =>
    Effect.gen(function* () {
      const fake = fakeAudio()
      const started = yield* Deferred.make<void>()
      const closing = yield* Deferred.make<void>()
      const gate = promiseGate()
      const failure = new Error("native close failed")
      fake.started(() => Deferred.doneUnsafe(started, Effect.void))
      fake.holdClose(
        async () => {
          await gate.promise
          throw failure
        },
        () => Deferred.doneUnsafe(closing, Effect.void)
      )
      const scope = yield* Scope.make()
      const resource = yield* makeInteractionSoundResource(
        () => fake.audio,
        () => true
      ).pipe(Effect.provideService(Scope.Scope, scope))
      yield* resource.play().pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const closed = yield* Scope.close(scope, Exit.void).pipe(
        Effect.exit,
        Effect.forkChild
      )
      yield* Deferred.await(closing)
      expect(closed.pollUnsafe()).toBeUndefined()
      gate.release()
      const result = yield* Fiber.join(closed)
      expect(Exit.isFailure(result)).toBe(true)
      expect(fake.calls).toContain("oscillatorDisconnect")
    })
)

test("the React cleanup observes a late close failure after unmount", async () => {
  const gate = promiseGate()
  const log = vi.spyOn(console, "log").mockImplementation(() => {})
  const error = vi.spyOn(console, "error").mockImplementation(() => {})
  class Audio {
    state = "running"
    createOscillator = () => ({ disconnect: () => {} })
    createGain = () => {
      throw new Error("gain unavailable")
    }
    close = async () => {
      await gate.promise
      throw new Error("late close failure")
    }
  }
  vi.stubGlobal("window", {
    AudioContext: Audio,
    localStorage: { getItem: () => null },
  })
  vi.stubGlobal("AudioContext", Audio)
  await useInteractionSound()()
  lifecycle.cleanup?.()
  lifecycle.cleanup = undefined
  expect(log).not.toHaveBeenCalled()
  expect(error).not.toHaveBeenCalled()
  gate.release()
  await vi.waitFor(() => {
    expect(
      [...log.mock.calls, ...error.mock.calls]
        .flat()
        .some((value) =>
          String(value).includes("InteractionSound.cleanupFailed")
        )
    ).toBe(true)
  })
})

it.effect(
  "normal playback retains a finalizer failure in the machine outcome",
  () =>
    Effect.gen(function* () {
      const fake = fakeAudio("gainDisconnect")
      const started = yield* Deferred.make<void>()
      fake.started(() => Deferred.doneUnsafe(started, Effect.void))
      const scope = yield* Scope.make()
      const resource = yield* makeInteractionSoundResource(
        () => fake.audio,
        () => true
      ).pipe(Effect.provideService(Scope.Scope, scope))
      const playing = yield* resource.play().pipe(Effect.forkChild)
      yield* Deferred.await(started)
      fake.finish()
      const outcome = yield* Fiber.join(playing)
      expect(Exit.isFailure(outcome) && outcome.cause.reasons).toMatchObject([
        {
          _tag: "Die",
          defect: { _tag: "Fail", error: { message: "gainDisconnect" } },
        },
      ])
      expect(fake.calls).toContain("oscillatorDisconnect")
      expect(fake.listeners.size).toBe(0)
      const closed = yield* Scope.close(scope, Exit.void).pipe(Effect.exit)
      expect(Exit.isFailure(closed)).toBe(true)
      expect(fake.calls).toContain("close")
    })
)
