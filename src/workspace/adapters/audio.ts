import { Effect, Schema } from "effect"

import type { AgentEnv } from "../../../alchemy.run"
import { nativeOperation } from "../../shared/interop"
import {
  AudioTranscript,
  AudioUnreadable,
  AUDIO_TEXT_LIMIT,
  type TranscribeAudio,
} from "../audio"
import { WorkspaceUnavailable } from "../files"

const base64 = (bytes: Uint8Array) => {
  let text = ""
  for (let offset = 0; offset < bytes.length; offset += 8192)
    text += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return btoa(text)
}
export function transcribeAudio(
  ai: Pick<AgentEnv["AI"], "run">
): TranscribeAudio {
  return Effect.fn("Audio.transcribe")(function* (bytes) {
    const response = yield* nativeOperation(
      () =>
        ai.run("@cf/openai/whisper-large-v3-turbo", {
          audio: base64(bytes),
          task: "transcribe",
          vad_filter: true,
          condition_on_previous_text: false,
        }),
      () => new WorkspaceUnavailable()
    )
    const duration = response.transcription_info?.duration ?? null
    if (duration !== null && duration > 600)
      return yield* new AudioUnreadable({
        message: "Use a voice message up to ten minutes long.",
      })
    const text = response.text.trim()
    if (!text)
      return yield* new AudioUnreadable({
        message: "No speech was found. Try a clearer recording.",
      })
    return yield* Effect.sync(() =>
      Schema.decodeUnknownSync(AudioTranscript)({
        text: text.slice(0, AUDIO_TEXT_LIMIT),
        duration,
        language: response.transcription_info?.language ?? null,
        truncated: text.length > AUDIO_TEXT_LIMIT,
        characters: Math.min(text.length, AUDIO_TEXT_LIMIT),
        source: "transcribed",
      })
    )
  })
}
