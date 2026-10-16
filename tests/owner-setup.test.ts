import { APIError } from "better-auth/api"
import { Cause, Effect } from "effect"
import { AuthStorageError } from "../src/auth/adapters/accounts"
import { expect, it, vi } from "vitest"
import {
  ownerSetup,
  OwnerSetupRejected,
  type OwnerSetupBindings,
} from "../src/auth/adapters/owner-setup"

vi.mock("../src/observability/events", () => ({ reportService: vi.fn() }))

const input = { name: "Owner", password: "synthetic-password" }
function request(
  body: unknown = input,
  options: { origin?: string; secret?: string; signal?: AbortSignal } = {}
) {
  return new Request("https://private.example/api/setup", {
    method: "POST",
    headers: {
      origin: options.origin ?? "https://private.example",
      "x-setup-token": options.secret ?? "synthetic-setup-secret",
    },
    body: JSON.stringify(body),
    signal: options.signal,
  })
}
function fixture() {
  const registered = vi.fn(async () => false)
  const signUp = vi.fn<OwnerSetupBindings["signUp"]>(async () => {})
  const own = vi.fn<OwnerSetupBindings["own"]>()
  const bindings: OwnerSetupBindings = {
    appUrl: "https://private.example",
    ownerEmail: "owner@example.com",
    secret: "synthetic-setup-secret",
    registered: () =>
      Effect.tryPromise({
        try: registered,
        catch: (cause) => new AuthStorageError({ cause }),
      }).pipe(Effect.uninterruptible),
    signUp,
    own,
  }
  return { registered, signUp, own, bindings }
}
function gate<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void
  const pending = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { pending, resolve, reject }
}
const hasDefect = (cause: unknown, defect: unknown) =>
  Cause.isCause(cause) &&
  cause.reasons.some(
    (reason) => reason._tag === "Die" && reason.defect === defect
  )

it("creates only the configured owner, pins work and returns private success without credentials", async () => {
  const f = fixture()
  const response = await ownerSetup(
    request({ ...input, email: "forged@example.com" }),
    f.bindings
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true })
  expect(response.headers.get("cache-control")).toBe("private, no-store")
  expect(f.signUp).toHaveBeenCalledExactlyOnceWith({
    ...input,
    email: "owner@example.com",
  })
  expect(f.own).toHaveBeenCalledOnce()
  await expect(f.own.mock.calls[0]?.[0]).resolves.toBeDefined()
})
it.each([
  { origin: "https://attacker.example" },
  { secret: "" },
  { secret: "wrong" },
])("rejects unauthorized owner setup before storage (%o)", async (options) => {
  const f = fixture()
  expect((await ownerSetup(request(input, options), f.bindings)).status).toBe(
    403
  )
  expect(f.registered).not.toHaveBeenCalled()
  expect(f.signUp).not.toHaveBeenCalled()
})
it("retains the existing registered-owner response and never signs up again", async () => {
  const f = fixture()
  f.registered.mockResolvedValue(true)
  const response = await ownerSetup(request(), f.bindings)
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ error: "Owner already registered." })
  expect(f.signUp).not.toHaveBeenCalled()
})
it.each([
  {},
  { ...input, password: "short" },
  { ...input, name: "x".repeat(17_000) },
])("rejects invalid or oversized owner input (%#)", async (body) => {
  const f = fixture()
  const response = await ownerSetup(request(body), f.bindings)
  expect(response.status).toBe(400)
  expect(f.signUp).not.toHaveBeenCalled()
})
it("maps documented Better Auth input errors without exposing their diagnostics", async () => {
  const f = fixture()
  f.signUp.mockRejectedValue(
    new APIError("BAD_REQUEST", { message: "Private input diagnostic" })
  )
  const response = await ownerSetup(request(), f.bindings)
  expect(response.status).toBe(400)
  expect(JSON.stringify(await response.json())).not.toContain("Private")
})
it.each(["lookup", "signup"])(
  "keeps an opaque native %s outage distinct from invalid input",
  async (mode) => {
    const f = fixture()
    if (mode === "lookup")
      f.registered.mockRejectedValue(new Error("Private database failure"))
    else
      f.signUp.mockRejectedValue(
        new APIError("INTERNAL_SERVER_ERROR", {
          message: "Private database failure",
        })
      )
    const response = await ownerSetup(request(), f.bindings)
    expect(response.status).toBe(503)
    expect(JSON.stringify(await response.json())).not.toContain("Private")
  }
)
it("decodes its finite expected rejection after prototype loss", async () => {
  const f = fixture(),
    error = new OwnerSetupRejected({ reason: "invalid" })
  Object.setPrototypeOf(error, Error.prototype)
  f.signUp.mockRejectedValue(error)
  expect((await ownerSetup(request(), f.bindings)).status).toBe(400)
})
it("retains a compound local failure rather than returning a setup rejection", async () => {
  const f = fixture(),
    defect = new Error("Private setup defect")
  f.signUp.mockRejectedValue(
    Cause.fromReasons([
      Cause.makeFailReason(new OwnerSetupRejected({ reason: "invalid" })),
      Cause.makeDieReason(defect),
      Cause.makeInterruptReason(),
    ])
  )
  await expect(ownerSetup(request(), f.bindings)).rejects.toSatisfy((cause) =>
    hasDefect(cause, defect)
  )
})
it("does not admit already-cancelled setup", async () => {
  const f = fixture(),
    controller = new AbortController()
  controller.abort()
  await expect(
    ownerSetup(request(input, { signal: controller.signal }), f.bindings)
  ).rejects.toSatisfy(
    (cause) => Cause.isCause(cause) && Cause.hasInterrupts(cause)
  )
  expect(f.registered).not.toHaveBeenCalled()
  expect(f.signUp).not.toHaveBeenCalled()
})
it("joins lookup after cancellation and admits no signup afterwards", async () => {
  const f = fixture(),
    entered = gate<void>(),
    pending = gate<boolean>(),
    controller = new AbortController()
  f.registered.mockImplementation(() => {
    entered.resolve()
    return pending.pending
  })
  let completed = false
  const result = ownerSetup(
    request(input, { signal: controller.signal }),
    f.bindings
  ).catch((cause) => {
    completed = true
    return cause
  })
  await entered.pending
  controller.abort()
  await Promise.resolve()
  expect(completed).toBe(false)
  pending.resolve(false)
  const cause: unknown = await result
  expect(Cause.isCause(cause) && Cause.hasInterrupts(cause)).toBe(true)
  expect(f.signUp).not.toHaveBeenCalled()
})
it("joins an admitted signup acknowledgement after cancellation and retains a late defect", async () => {
  const f = fixture(),
    entered = gate<void>(),
    pending = gate<void>(),
    controller = new AbortController()
  f.signUp.mockImplementation(() => {
    entered.resolve()
    return pending.pending
  })
  let completed = false
  const result = ownerSetup(
    request(input, { signal: controller.signal }),
    f.bindings
  ).catch((cause) => {
    completed = true
    return cause
  })
  await entered.pending
  controller.abort()
  await Promise.resolve()
  expect(completed).toBe(false)
  const defect = new Error("Private late signup defect")
  pending.reject(Cause.die(defect))
  expect(hasDefect(await result, defect)).toBe(true)
  expect(f.signUp).toHaveBeenCalledOnce()
})
it("joins oversized-body cancellation and retains cleanup failure", async () => {
  const f = fixture(),
    entered = gate<void>(),
    closing = gate<void>(),
    defect = new Error("Private setup reader cleanup")
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => controller.enqueue(new Uint8Array(16_385)),
    cancel: () => {
      entered.resolve()
      return closing.pending
    },
  })
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: {
      origin: "https://private.example",
      "x-setup-token": f.bindings.secret,
    },
    body,
    duplex: "half",
  }
  let completed = false
  const result = ownerSetup(
    new Request("https://private.example/api/setup", init),
    f.bindings
  ).catch((cause) => {
    completed = true
    return cause
  })
  await entered.pending
  expect(completed).toBe(false)
  closing.reject(defect)
  expect(hasDefect(await result, defect)).toBe(true)
  expect(body.locked).toBe(false)
  expect(f.signUp).not.toHaveBeenCalled()
})
it("rejects failed work ownership before storage or signup admission", async () => {
  const f = fixture(),
    defect = new Error("Cannot register setup work")
  f.own.mockImplementation(() => {
    throw defect
  })
  await expect(ownerSetup(request(), f.bindings)).rejects.toSatisfy((cause) =>
    hasDefect(cause, defect)
  )
  expect(f.registered).not.toHaveBeenCalled()
  expect(f.signUp).not.toHaveBeenCalled()
})
