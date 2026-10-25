import { expect, it, vi } from "vitest"

import { requestRevision } from "../src/features/updates/version-request"

it("unsuccessful version headers retain ownership until response body cancellation joins", async () => {
  let release!: () => void
  const held = new Promise<void>((done) => {
    release = done
  })
  const cancel = vi.fn(() => held)
  const fetcher = vi.fn(
    async () => new Response(new ReadableStream({ cancel }), { status: 503 })
  )
  let completed = false
  const result = requestRevision(new AbortController().signal, fetcher).then(
    (value) => {
      completed = true
      return value
    }
  )
  try {
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1))
    expect(completed).toBe(false)
    release()
    expect(await result).toBeNull()
  } finally {
    release()
    await result
  }
})
