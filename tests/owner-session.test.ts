import { Effect } from "effect"
import { APIError } from "better-auth/api"
import { expect, it, vi } from "vitest"
import {
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
