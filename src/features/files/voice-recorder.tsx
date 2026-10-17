import { Mic, Square, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { InputGroupButton } from "@/components/ui/input-group"
import { MAX_FILE_BYTES } from "@/workspace/files"

/** The browser owns capture only. The resulting File enters the normal shared
 * upload/transcription pipeline, just like a file picked on any other surface. */
export function VoiceRecorder({
  disabled,
  onRecorded,
}: {
  disabled: boolean
  onRecorded: (file: File) => Promise<void>
}) {
  const [state, setState] = useState<"idle" | "starting" | "recording">("idle")
  const [error, setError] = useState("")
  const capture = useRef<{
    recorder: MediaRecorder
    chunks: Blob[]
    bytes: number
    timer: ReturnType<typeof setTimeout>
    cancelled: boolean
  } | null>(null)
  const mounted = useRef(true)
  const generation = useRef(0)
  const stop = (cancelled: boolean) => {
    generation.current++
    const current = capture.current
    if (!current) return
    current.cancelled = cancelled
    clearTimeout(current.timer)
    if (current.recorder.state !== "inactive") current.recorder.stop()
    current.recorder.stream.getTracks().forEach((track) => track.stop())
  }
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      stop(true)
    }
  }, [])
  async function start() {
    const expected = ++generation.current
    setError("")
    setState("starting")
    let stream: MediaStream | undefined
    try {
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined"
      )
        throw new Error(
          "Voice recording is unavailable in this browser. You can upload an audio file."
        )
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const input = stream
      if (!mounted.current || expected !== generation.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      const mimeType = [
        "audio/webm;codecs=opus",
        "audio/ogg;codecs=opus",
        "audio/mp4",
      ].find((mime) => MediaRecorder.isTypeSupported(mime))
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined
      )
      const current = {
        recorder,
        chunks: [] as Blob[],
        bytes: 0,
        timer: setTimeout(() => {
          if (expected === generation.current) stop(false)
        }, 600_000),
        cancelled: false,
      }
      capture.current = current
      recorder.ondataavailable = (event) => {
        if (current.cancelled) return
        current.bytes += event.data.size
        if (current.bytes > MAX_FILE_BYTES) {
          stop(true)
          if (mounted.current)
            setError("This recording exceeded 8 MB. Try a shorter message.")
          return
        }
        if (event.data.size) current.chunks.push(event.data)
      }
      recorder.onstop = () => {
        clearTimeout(current.timer)
        const active = capture.current === current
        if (active) capture.current = null
        input.getTracks().forEach((track) => track.stop())
        if (!mounted.current || !active) return
        setState("idle")
        if (current.cancelled || !current.bytes) return
        const mime = recorder.mimeType.split(";")[0] || "audio/webm"
        const extension =
          mime === "audio/mp4" ? "m4a" : mime === "audio/ogg" ? "ogg" : "webm"
        void onRecorded(
          new File(current.chunks, `voice-message.${extension}`, { type: mime })
        ).catch(() => {
          if (mounted.current)
            setError("Could not upload this recording. Try again.")
        })
      }
      recorder.onerror = () => {
        if (capture.current !== current) return
        stop(true)
        if (mounted.current)
          setError("Recording failed. Try again or upload an audio file.")
      }
      recorder.start(1000)
      setState("recording")
    } catch (cause) {
      stream?.getTracks().forEach((track) => track.stop())
      if (!mounted.current || expected !== generation.current) return
      if (capture.current) {
        clearTimeout(capture.current.timer)
        capture.current = null
      }
      setState("idle")
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not access the microphone."
      )
    }
  }
  return (
    <>
      {state === "idle" ? (
        <InputGroupButton
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          aria-label="Record voice message"
          onClick={() => void start()}
        >
          <Mic />
        </InputGroupButton>
      ) : (
        <>
          <InputGroupButton
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={state === "starting"}
            aria-label="Finish voice message"
            onClick={() => stop(false)}
          >
            <Square />
          </InputGroupButton>
          <InputGroupButton
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Cancel voice recording"
            onClick={() => {
              stop(true)
              setState("idle")
            }}
          >
            <X />
          </InputGroupButton>
          <span role="status" className="text-xs text-muted-foreground">
            {state === "starting" ? "Opening microphone…" : "Recording…"}
          </span>
        </>
      )}
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </>
  )
}
