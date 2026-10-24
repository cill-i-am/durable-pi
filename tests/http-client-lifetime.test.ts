import { Cause, Context, Equal } from "effect"
import { afterEach, expect, it, vi } from "vitest"

import { ApiError, api } from "../src/http/client"

afterEach(() => vi.unstubAllGlobals())
it("joins an unread 401 body and retains the original API error", async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const cancel = vi.fn(() => held)
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => new Response(new ReadableStream({ cancel }), { status: 401 })
    )
  )
  let settled = false
  const request = api("/owned").catch((cause: unknown) => {
    settled = true
    return cause
  })
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
  expect(settled).toBe(false)
  release()
  expect(await request).toMatchObject({
    status: 401,
    message: "Your session has expired. Sign in again.",
  })
})
it("preserves structured error-body Causes and ordinary API error status/code", async () => {
  class Marker extends Context.Service<Marker, string>()("HttpBodyMarker") {}
  const cause = Cause.fromReasons([
    Cause.makeFailReason("body failed"),
    Cause.makeDieReason("body defect"),
    Cause.makeInterruptReason(89235).annotate(Context.make(Marker, "body")),
  ])
  const response = new Response("unread", { status: 503 })
  vi.spyOn(response, "json").mockRejectedValue(cause)
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response)
  )
  expect(
    Equal.equals(await api("/owned").catch((error: unknown) => error), cause)
  ).toBe(true)
  expect(response.bodyUsed).toBe(true)
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: "Conflict", code: "revision_changed" }),
          { status: 409 }
        )
    )
  )
  await expect(api("/owned")).rejects.toMatchObject({
    status: 409,
    message: "Conflict",
    code: "revision_changed",
  })
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("invalid", { status: 500 }))
  )
  await expect(api("/owned")).rejects.toMatchObject({
    status: 500,
    message: "Connection interrupted. Please retry.",
  })
})
it("combines the original HTTP error with every annotated cancellation reason", async () => {
  class Marker extends Context.Service<Marker, string>()("HttpCancelMarker") {}
  const cause = Cause.fromReasons([
    Cause.makeFailReason("cancel failed"),
    Cause.makeDieReason("cancel defect"),
    Cause.makeInterruptReason(89236).annotate(Context.make(Marker, "cancel")),
  ])
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({ cancel: () => Promise.reject(cause) }),
          { status: 401 }
        )
    )
  )
  const result = await api("/owned").catch((error: unknown) => error)
  expect(Cause.isCause(result)).toBe(true)
  if (!Cause.isCause(result)) return
  expect(
    result.reasons.some(
      (reason) =>
        reason._tag === "Fail" &&
        reason.error instanceof ApiError &&
        reason.error.status === 401
    )
  ).toBe(true)
  expect(
    result.reasons.some(
      (reason) =>
        reason._tag === "Die" && Equal.equals(reason.defect, cause.reasons[0])
    )
  ).toBe(true)
  expect(
    result.reasons.some(
      (reason) => reason._tag === "Die" && reason.defect === "cancel defect"
    )
  ).toBe(true)
  expect(
    result.reasons.some(
      (reason) =>
        reason._tag === "Interrupt" &&
        reason.fiberId === 89236 &&
        reason.annotations.get(Marker.key) === "cancel"
    )
  ).toBe(true)
})
