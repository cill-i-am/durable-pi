import { expect, it, vi } from "vitest"
import { pollFiles } from "../src/features/files/poll"

it("accepts slow polls before scheduling another and stops on unmount", async () => {
  vi.useFakeTimers()
  let finish!: () => void
  const refresh = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const stop = pollFiles(refresh)
  try {
    await vi.advanceTimersByTimeAsync(2000)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(refresh).toHaveBeenCalledTimes(1)
    finish()
    await vi.advanceTimersByTimeAsync(2000)
    expect(refresh).toHaveBeenCalledTimes(2)
    stop()
    finish()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(refresh).toHaveBeenCalledTimes(2)
  } finally {
    stop()
    vi.useRealTimers()
  }
})
