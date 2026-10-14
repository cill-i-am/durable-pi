import { useEffect, useRef } from "react"

import { isInteractionSoundEnabled } from "./interaction-sound-preference"

const closeAudio = async (audio: AudioContext) => {
  try {
    await audio.close()
  } catch {}
}

export const useInteractionSound = () => {
  const context = useRef<AudioContext | null>(null)

  useEffect(
    () => () => {
      const audio = context.current
      context.current = null
      if (audio !== null) {
        void closeAudio(audio)
      }
    },
    []
  )

  return async ({ preview = false }: { preview?: boolean } = {}) => {
    if (
      (!preview && !isInteractionSoundEnabled()) ||
      !("AudioContext" in window)
    ) {
      return
    }
    try {
      const audio = context.current ?? new AudioContext()
      context.current = audio
      if (audio.state === "suspended") {
        await audio.resume()
      }
      if (
        context.current !== audio ||
        audio.state !== "running" ||
        (!preview && !isInteractionSoundEnabled())
      ) {
        return
      }

      const oscillator = audio.createOscillator()
      const gain = audio.createGain()
      const start = audio.currentTime
      const end = start + 0.02
      oscillator.type = "triangle"
      oscillator.frequency.setValueAtTime(850, start)
      oscillator.frequency.exponentialRampToValueAtTime(160, end)
      gain.gain.setValueAtTime(0.12, start)
      gain.gain.exponentialRampToValueAtTime(0.0001, end)
      oscillator.connect(gain)
      gain.connect(audio.destination)
      oscillator.addEventListener(
        "ended",
        () => {
          oscillator.disconnect()
          gain.disconnect()
        },
        { once: true }
      )
      oscillator.start(start)
      oscillator.stop(end)
    } catch {}
  }
}
