import { APIError } from "better-auth/api"
import { Cause, Effect, Exit } from "effect"
import { expect, it, vi } from "vitest"

import {
  OwnerSessionUnavailable,
  ownerSession,
  sessionUnavailableResponse,
} from "../src/auth/owner-session"

it("maps a native Better Auth lookup error to 503 without reaching protected work", async () => {
  const action = vi.fn()
  const response = await Effect.runPromise(
    ownerSession(async () => {
      throw new APIError("INTERNAL_SERVER_ERROR", {
        message: "Failed to get session",
      })
    }, "owner@example.test").pipe(
      Effect.flatMap(() =>
        Effect.sync(() => {
          action()
          return new Response("secret")
        })
      ),
      Effect.catchTag("OwnerSessionUnavailable", sessionUnavailableResponse)
    )
  )
  expect(response.status).toBe(503)
  expect(response.headers.get("Retry-After")).toBe("5")
  expect(response.headers.get("Cache-Control")).toContain("no-store")
  expect(action).not.toHaveBeenCalled()
  expect(await response.json()).toMatchObject({ code: "SESSION_UNAVAILABLE" })
})
it("retains anonymous and different-owner rejection and fresh owner validation", async () => {
  expect(
    await Effect.runPromise(
      ownerSession(async () => null, "owner@example.test")
    )
  ).toBeNull()
  expect(
    await Effect.runPromise(
      ownerSession(
        async () => ({ user: { id: "other", email: "other@example.test" } }),
        "owner@example.test"
      )
    )
  ).toBeNull()
  const user = { id: "owner", email: "OWNER@example.test" }
  expect(
    await Effect.runPromise(
      ownerSession(async () => ({ user }), "owner@example.test")
    )
  ).toEqual(user)
})
it("does not admit a session lookup for a pre-aborted request", async () => {
  const controller = new AbortController(),
    read = vi.fn(async () => null)
  controller.abort()
  const exit = await Effect.runPromiseExit(
    ownerSession(read, "owner@example.test"),
    { signal: controller.signal }
  )
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  expect(read).not.toHaveBeenCalled()
})
it.each(["defect", "interruption", "mixed"])(
  "retains complete native session %s meanings",
  async (mode) => {
    const cause = Cause.fromReasons(
      mode === "defect"
        ? [Cause.makeDieReason("Private defect")]
        : mode === "interruption"
          ? [Cause.makeInterruptReason(73)]
          : [
              Cause.makeFailReason(
                new OwnerSessionUnavailable({ cause: "Private lookup" })
              ),
              Cause.makeDieReason("Private defect"),
              Cause.makeInterruptReason(73),
            ]
    )
    const exit = await Effect.runPromiseExit(
      ownerSession(() => Promise.reject(cause), "owner@example.test")
    )
    expect(
      Exit.isFailure(exit) && exit.cause.reasons.map((reason) => reason._tag)
    ).toEqual(cause.reasons.map((reason) => reason._tag))
  }
)
it("joins an admitted session lookup and retains its late defect after cancellation", async () => {
  let enter!: () => void, reject!: (cause: unknown) => void
  const entered = new Promise<void>((done) => {
    enter = done
  })
  const reply = new Promise<null>((_done, fail) => {
    reject = fail
  })
  const controller = new AbortController()
  let settled = false
  const running = Effect.runPromiseExit(
    ownerSession(() => {
      enter()
      return reply
    }, "owner@example.test"),
    { signal: controller.signal }
  ).finally(() => {
    settled = true
  })
  await entered
  controller.abort()
  expect(settled).toBe(false)
  const defect = new Error("Late session defect")
  reject(Cause.die(defect))
  const exit = await running
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  expect(
    Exit.isFailure(exit) &&
      exit.cause.reasons.some(
        (reason) => reason._tag === "Die" && reason.defect === defect
      )
  ).toBe(true)
})
