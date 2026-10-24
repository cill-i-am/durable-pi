import { Cause, Deferred, Effect, Exit, Fiber, Scope, Semaphore } from "effect"

import { orDieAll } from "@/shared/effect"
import { nativeOperation } from "@/shared/interop"
import { MAX_FILE_BYTES } from "@/workspace/files"

import { fileWorkFailures } from "./owned-work"
import type { VoiceCapture } from "./voice-recorder.machine"

// React may mount the next agent before the old owner's asynchronous cleanup ends.
// The browser microphone permit spans acquisition, native stop and track release.
const microphone = Semaphore.makeUnsafe(1)

export interface VoicePlatform {
  acquire: () => Promise<MediaStream>
  recorder: (stream: MediaStream) => MediaRecorder
}
export const browserVoice: VoicePlatform = {
  acquire: () => {
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    )
      return Promise.reject(
        new Error(
          "Voice recording is unavailable in this browser. You can upload an audio file."
        )
      )
    return navigator.mediaDevices.getUserMedia({ audio: true })
  },
  recorder: (stream) => {
    const mimeType = [
      "audio/webm;codecs=opus",
      "audio/ogg;codecs=opus",
      "audio/mp4",
    ].find((mime) => MediaRecorder.isTypeSupported(mime))
    return new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
  },
}

function record(
  stream: MediaStream,
  platform: VoicePlatform,
  finish: Deferred.Deferred<void>
) {
  return Effect.gen(function* () {
    const recorder = yield* Effect.try({
      try: () => platform.recorder(stream),
      catch: (cause) => cause,
    })
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        yield* Deferred.await(finish).pipe(
          Effect.andThen(Deferred.await(started)),
          Effect.andThen(
            Effect.sync(() => {
              if (recorder.state !== "inactive") recorder.stop()
            })
          ),
          Effect.forkChild
        )
        return yield* nativeOperation(
          (signal) =>
            new Promise<File | null>((resolve, reject) => {
              const chunks: Blob[] = []
              let bytes = 0,
                failed: unknown
              const stop = () => {
                try {
                  if (recorder.state !== "inactive") recorder.stop()
                } catch (cause) {
                  clear()
                  reject(cause)
                }
              }
              const clear = () => {
                recorder.ondataavailable = null
                recorder.onerror = null
                recorder.onstop = null
                signal.removeEventListener("abort", stop)
              }
              recorder.ondataavailable = (event) => {
                if (signal.aborted || failed) return
                bytes += event.data.size
                if (bytes > MAX_FILE_BYTES) {
                  failed = new Error(
                    "This recording exceeded 8 MB. Try a shorter message."
                  )
                  stop()
                } else if (event.data.size) chunks.push(event.data)
              }
              recorder.onerror = () => {
                failed = new Error(
                  "Recording failed. Try again or upload an audio file."
                )
                stop()
              }
              recorder.onstop = () => {
                clear()
                if (failed) {
                  reject(failed)
                  return
                }
                if (signal.aborted || !bytes) {
                  resolve(null)
                  return
                }
                const mime = recorder.mimeType.split(";")[0] || "audio/webm"
                const extension =
                  mime === "audio/mp4"
                    ? "m4a"
                    : mime === "audio/ogg"
                      ? "ogg"
                      : "webm"
                resolve(
                  new File(chunks, `voice-message.${extension}`, { type: mime })
                )
              }
              signal.addEventListener("abort", stop, { once: true })
              try {
                recorder.start(1000)
                Deferred.doneUnsafe(started, Effect.void)
              } catch (cause) {
                clear()
                reject(cause)
              }
            }),
          (cause) => cause
        )
      })
    )
  })
}

/** The resource scope joins a non-abortable permission request and native stop. */
export function openVoiceCapture(
  platform: VoicePlatform = browserVoice,
  observe: Effect.Success<typeof fileWorkFailures> = (work) => work
): Effect.Effect<VoiceCapture, never, Scope.Scope> {
  return Effect.gen(function* () {
    let failure: Cause.Cause<unknown> | undefined
    const close = (scope: Scope.Closeable) =>
      Scope.close(scope, Exit.void).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            failure && Cause.hasDies(failure)
              ? Effect.failCause(failure).pipe(orDieAll)
              : Effect.void
          )
        )
      )
    const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      close(scope)
    )
    const ready = yield* Deferred.make<void, unknown>()
    const begin = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()
    const fiber = yield* Effect.gen(function* () {
      let stream: MediaStream | undefined
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const exits = yield* Effect.forEach(
            stream?.getTracks() ?? [],
            (track) => Effect.exit(Effect.sync(() => track.stop()))
          )
          const reasons = exits.flatMap((exit) =>
            Exit.isFailure(exit) ? exit.cause.reasons : []
          )
          if (reasons.length)
            return yield* Effect.failCause(Cause.fromReasons(reasons)).pipe(
              orDieAll
            )
        })
      )
      const input = yield* nativeOperation(
        () =>
          platform.acquire().then((value) => {
            stream = value
            return value
          }),
        (cause) => cause
      )
      yield* Deferred.succeed(ready, undefined)
      yield* Deferred.await(begin)
      return yield* record(input, platform, finish)
    }).pipe(
      Effect.scoped,
      microphone.withPermit,
      Effect.onExit((exit) => {
        if (Exit.isSuccess(exit)) return Effect.void
        failure = exit.cause
        return Deferred.failCause(ready, exit.cause).pipe(Effect.asVoid)
      }),
      observe,
      Effect.forkIn(scope)
    )
    return {
      ready: Deferred.await(ready),
      record: Deferred.succeed(begin, undefined).pipe(
        Effect.andThen(Fiber.join(fiber))
      ),
      finish: Deferred.succeed(finish, undefined).pipe(
        Effect.andThen(Fiber.join(fiber))
      ),
      close: close(scope),
    }
  })
}
