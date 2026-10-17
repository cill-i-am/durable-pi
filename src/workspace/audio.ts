import { Schema, type Effect } from "effect"

import type { WorkspaceUnavailable } from "./files"

export const AUDIO_TEXT_LIMIT = 32_000
export const AudioMime = Schema.Literals([
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/webm",
  "audio/wav",
  "audio/aac",
  "audio/flac",
  "audio/amr",
])
export const AudioMetadata = Schema.Struct({
  duration: Schema.NullOr(
    Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 600 }))
  ),
  language: Schema.NullOr(Schema.String.check(Schema.isMaxLength(40))),
  characters: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: AUDIO_TEXT_LIMIT })
  ),
  truncated: Schema.Boolean,
  source: Schema.Literal("transcribed"),
})
export type AudioMetadata = typeof AudioMetadata.Type
export const StoredAudio = Schema.Struct({
  ...AudioMetadata.fields,
  textHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
})
export type StoredAudio = typeof StoredAudio.Type
export const AudioTranscript = Schema.Struct({
  ...AudioMetadata.fields,
  text: Schema.String.check(Schema.isMaxLength(AUDIO_TEXT_LIMIT)),
})
export type AudioTranscript = typeof AudioTranscript.Type
export class AudioUnreadable extends Schema.TaggedError<AudioUnreadable>()(
  "AudioUnreadable",
  { message: Schema.String }
) {}
export type TranscribeAudio = (
  bytes: Uint8Array
) => Effect.Effect<AudioTranscript, AudioUnreadable | WorkspaceUnavailable>

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  new TextDecoder().decode(bytes.subarray(start, end))
/** Recognize supported containers without trusting a transport's MIME label. */
export function audioMime(
  bytes: Uint8Array,
  hint = ""
): typeof AudioMime.Type | undefined {
  const mime = hint.toLowerCase().split(";")[0]?.trim()
  if (ascii(bytes, 0, 5) === "#!AMR") return "audio/amr"
  if (ascii(bytes, 0, 4) === "OggS") return "audio/ogg"
  if (ascii(bytes, 0, 4) === "fLaC") return "audio/flac"
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE")
    return "audio/wav"
  if (bytes.length >= 10 && ascii(bytes, 0, 3) === "ID3") return "audio/mpeg"
  if (bytes.length >= 32 && bytes[0] === 255 && (bytes[1]! & 0xe0) === 0xe0)
    return (bytes[1]! & 0xf6) === 0xf0 ? "audio/aac" : "audio/mpeg"
  if (
    ["audio/mp4", "audio/x-m4a", "audio/m4a"].includes(mime ?? "") &&
    ascii(bytes, 4, 8) === "ftyp"
  )
    return "audio/mp4"
  if (
    mime === "audio/webm" &&
    [0x1a, 0x45, 0xdf, 0xa3].every((value, index) => bytes[index] === value)
  )
    return "audio/webm"
  return undefined
}

export const audioMetadata = (
  { text: _text, ...metadata }: AudioTranscript,
  textHash: string
): StoredAudio => ({ ...metadata, textHash })
