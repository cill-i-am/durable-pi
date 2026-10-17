import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"

import { transcribeAudio } from "../src/workspace/adapters/audio"
import { audioBytes } from "./audio-fixture"

// The platform exposes many unrelated generic overloads. This test boundary
// supplies only the response selected by each scenario; native workerd also
// exercises this adapter against the retained platform-shaped binding.
function binding() {
  const run =
    vi.fn<
      (model: string, input: unknown, options?: unknown) => Promise<unknown>
    >()
  return { run, ai: { run: run as Ai["run"] } }
}

describe("Cloudflare transcription adapter", () => {
  it("transcribes without translating, and returns a bounded transcript with its provenance", async () => {
    const { ai, run } = binding()
    run.mockResolvedValueOnce({
      text: "Bonjour",
      transcription_info: { duration: 2, language: "fr" },
    })
    expect(await Effect.runPromise(transcribeAudio(ai)(audioBytes))).toEqual({
      text: "Bonjour",
      duration: 2,
      language: "fr",
      source: "transcribed",
      truncated: false,
      characters: 7,
    })
    expect(run).toHaveBeenCalledWith(
      "@cf/openai/whisper-large-v3-turbo",
      expect.objectContaining({
        task: "transcribe",
        condition_on_previous_text: false,
        vad_filter: true,
      })
    )
  })
  it.each([
    { text: "", transcription_info: { duration: 1 } },
    { text: "Too long", transcription_info: { duration: 601 } },
  ])(
    "rejects no speech and recordings beyond the duration bound",
    async (response) => {
      const { ai, run } = binding()
      run.mockResolvedValueOnce(response)
      await expect(
        Effect.runPromise(transcribeAudio(ai)(audioBytes))
      ).rejects.toMatchObject({ _tag: "AudioUnreadable" })
    }
  )
})
