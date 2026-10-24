import { createEffectActor, send, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber } from "effect"
import { Mic, Square, X } from "lucide-react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type { SnapshotFrom } from "xstate"

import { InputGroupButton } from "@/components/ui/input-group"
import { useReloadGuard } from "@/features/updates/update-recovery"
import { nativeOperation } from "@/shared/interop"

import { fileWorkFailures } from "./owned-work"
import { openVoiceCapture } from "./voice-capture"
import { voiceRecorderMachine } from "./voice-recorder.machine"

type Machine = ReturnType<typeof voiceRecorderMachine>

/** Capture is browser-owned; the finished File uses the shared upload pipeline. */
export function VoiceRecorder({
  disabled,
  onRecorded,
}: {
  disabled: boolean
  onRecorded: (file: File) => Promise<void>
}) {
  const recorded = useRef(onRecorded)
  useLayoutEffect(() => {
    recorded.current = onRecorded
  }, [onRecorded])
  const [actor, setActor] = useState<EffectActor<Machine> | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<Machine> | null>(null)
  useEffect(() => {
    let mounted = true
    const owner = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const observe = yield* fileWorkFailures
          const owned = yield* createEffectActor(
            voiceRecorderMachine({
              open: () => openVoiceCapture(undefined, observe),
              upload: (file) =>
                observe(
                  nativeOperation(
                    () => recorded.current(file),
                    (cause) => cause
                  )
                ),
            })
          )
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              owned.subscribe((value) => {
                if (mounted) setSnapshot(value)
              })
            ),
            (subscription) => Effect.sync(() => subscription.unsubscribe())
          )
          if (mounted) {
            setActor(owned)
            setSnapshot(owned.getSnapshot())
          }
          return yield* Effect.never
        })
      )
    )
    return () => {
      mounted = false
      Effect.runFork(
        Fiber.interrupt(owner).pipe(
          Effect.andThen(Fiber.await(owner)),
          Effect.flatMap((exit) =>
            Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
              ? Effect.logError(exit.cause)
              : Effect.void
          )
        )
      )
    }
  }, [])
  const idle = !snapshot || snapshot.matches("idle")
  const acquiring =
    snapshot?.matches("opening") || snapshot?.matches("acquiring")
  const recording = snapshot?.matches("recording")
  const releasing = snapshot?.matches("releasing")
  const uploading = snapshot?.matches("uploading")
  const blocked = snapshot?.matches("blocked")
  useReloadGuard(
    "Finish or cancel the voice recording before reloading.",
    !idle
  )
  const command = (type: "START" | "FINISH" | "CANCEL") => {
    if (actor) Effect.runFork(send(actor, { type }))
  }
  return (
    <>
      {idle ? (
        <InputGroupButton
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled || !actor}
          aria-label="Record voice message"
          onClick={() => command("START")}
        >
          <Mic />
        </InputGroupButton>
      ) : (
        <>
          <InputGroupButton
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={!recording}
            aria-label="Finish voice message"
            onClick={() => command("FINISH")}
          >
            <Square />
          </InputGroupButton>
          <InputGroupButton
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={releasing || uploading || blocked}
            aria-label="Cancel voice recording"
            onClick={() => command("CANCEL")}
          >
            <X />
          </InputGroupButton>
          <span role="status" className="text-xs text-muted-foreground">
            {acquiring
              ? "Opening microphone…"
              : releasing
                ? "Releasing microphone…"
                : uploading
                  ? "Uploading recording…"
                  : recording
                    ? "Recording…"
                    : blocked
                      ? "Microphone release failed."
                      : "Finishing recording…"}
          </span>
        </>
      )}
      {snapshot?.context.error && (
        <span role="alert" className="text-xs text-destructive">
          {snapshot.context.error}
        </span>
      )}
    </>
  )
}
