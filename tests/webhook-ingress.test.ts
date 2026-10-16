import { expect, it, vi } from "vitest"
import { Cause, Effect } from "effect"
import { AuthStorageError } from "../src/auth/adapters/accounts"
import {
  receiveWebhook,
  type WebhookIngressBindings,
} from "../src/webhooks/adapters/public"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function fixture(
  options: {
    lookup?: () => Promise<unknown>
    forward?: (request: Request) => Promise<Response>
  } = {}
) {
  const lookup = vi.fn(options.lookup ?? (async () => "configured-owner"))
  const forward = vi.fn(
    options.forward ??
      (async () => Response.json({ accepted: true }, { status: 202 }))
  )
  const env: WebhookIngressBindings = {
    owner: () =>
      Effect.tryPromise({
        try: lookup,
        catch: (cause) => new AuthStorageError({ cause }),
      }).pipe(Effect.uninterruptible),
    AGENT_SERVICE: { fetch: forward },
  }
  const routine = crypto.randomUUID()
  return {
    env,
    lookup,
    forward,
    receive: (input: Request) => receiveWebhook(input, "home", routine, env),
  }
}
function request(
  options: {
    signal?: AbortSignal
    body?: string | ReadableStream<Uint8Array>
    headers?: Record<string, string>
  } = {}
) {
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    signal: options.signal,
    body: options.body ?? "{}",
    duplex: "half",
    headers: {
      authorization: `Bearer rpwh_${"1".repeat(64)}`,
      "x-event-id": "same-event",
      "content-type": "application/json",
      ...options.headers,
    },
  }
  return new Request("https://public.example/api/hooks/home/fixture", init)
}
const tags = (cause: unknown) =>
  Cause.isCause(cause) ? cause.reasons.map((reason) => reason._tag) : []

it("does not start public ingress for an already aborted request", async () => {
  const f = fixture(),
    controller = new AbortController()
  controller.abort()
  await expect(
    f.receive(request({ signal: controller.signal }))
  ).rejects.toSatisfy((cause: unknown) => tags(cause).includes("Interrupt"))
  expect(f.lookup).not.toHaveBeenCalled()
  expect(f.forward).not.toHaveBeenCalled()
})
const invalidHeaders: readonly {
  headers: Record<string, string>
  status: number
}[] = [
  { headers: { authorization: "bad" }, status: 401 },
  { headers: { "x-event-id": "invalid event" }, status: 400 },
  { headers: { "content-type": "text/plain" }, status: 415 },
]
it.each(invalidHeaders)(
  "rejects malformed public headers before looking up or forwarding ($status)",
  async ({ headers, status }) => {
    const f = fixture()
    const response = await f.receive(request({ headers }))
    expect(response.status).toBe(status)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(f.lookup).not.toHaveBeenCalled()
    expect(f.forward).not.toHaveBeenCalled()
  }
)
it("joins public request reader cancellation before returning interruption", async () => {
  const entered = deferred<void>(),
    closing = deferred<void>(),
    cancelling = deferred<void>()
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        entered.resolve()
      },
      cancel() {
        cancelling.resolve()
        return closing.promise
      },
    },
    { highWaterMark: 0 }
  )
  const f = fixture(),
    controller = new AbortController()
  let settled = false
  const observed = f
    .receive(request({ body, signal: controller.signal }))
    .catch((cause: unknown) => {
      settled = true
      return cause
    })
  await entered.promise
  controller.abort()
  await cancelling.promise
  expect(settled).toBe(false)
  closing.resolve()
  expect(tags(await observed)).toContain("Interrupt")
  expect(body.locked).toBe(false)
  expect(f.lookup).not.toHaveBeenCalled()
  expect(f.forward).not.toHaveBeenCalled()
})
it("does not turn failed public request cleanup into a payload rejection", async () => {
  const failure = new Error("private cancellation failure")
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(16_385))
    },
    cancel() {
      return Promise.reject(failure)
    },
  })
  const f = fixture()
  await expect(f.receive(request({ body }))).rejects.toSatisfy(
    (cause: unknown) => tags(cause).includes("Die")
  )
  expect(f.lookup).not.toHaveBeenCalled()
  expect(body.locked).toBe(false)
})
it("returns a safe payload rejection for oversized public input", async () => {
  const f = fixture()
  const response = await f.receive(request({ body: "x".repeat(16_385) }))
  expect(response.status).toBe(413)
  expect(f.lookup).not.toHaveBeenCalled()
  expect(f.forward).not.toHaveBeenCalled()
})
it("joins a cancelled native owner lookup and never forwards its late result", async () => {
  const entered = deferred<void>(),
    lookup = deferred<unknown>()
  const f = fixture({
    lookup: () => {
      entered.resolve()
      return lookup.promise
    },
  })
  const controller = new AbortController()
  let settled = false
  const observed = f
    .receive(request({ signal: controller.signal }))
    .catch((cause: unknown) => {
      settled = true
      return cause
    })
  await entered.promise
  controller.abort()
  await Promise.resolve()
  expect(settled).toBe(false)
  lookup.resolve("configured-owner")
  expect(tags(await observed)).toContain("Interrupt")
  expect(f.forward).not.toHaveBeenCalled()
})
it("decodes the native owner result before trusting it as request authority", async () => {
  const f = fixture({ lookup: async () => ({ id: "forged owner object" }) })
  await expect(f.receive(request())).rejects.toSatisfy((cause: unknown) =>
    tags(cause).includes("Die")
  )
  expect(f.forward).not.toHaveBeenCalled()
})
it("returns an unauthorized response when the configured owner does not exist", async () => {
  const f = fixture({ lookup: async () => null })
  expect((await f.receive(request())).status).toBe(401)
  expect(f.forward).not.toHaveBeenCalled()
})
it("projects an opaque owner-store rejection without exposing private diagnostics", async () => {
  const f = fixture({
    lookup: async () => {
      throw new Error("private database detail")
    },
  })
  const response = await f.receive(request())
  expect(response.status).toBe(503)
  expect(await response.text()).not.toContain("private database detail")
  expect(f.forward).not.toHaveBeenCalled()
})
it("preserves a full forwarding Cause instead of returning an ordinary unavailable response", async () => {
  const failure = Cause.fromReasons([
    Cause.makeDieReason("private forwarded defect"),
    Cause.makeInterruptReason(),
  ])
  const f = fixture({ forward: () => Promise.reject(failure) })
  await expect(f.receive(request())).rejects.toSatisfy(
    (cause: unknown) => tags(cause).join() === "Die,Interrupt"
  )
})
it("joins late forwarded-response cleanup and retains its failure after cancellation", async () => {
  const entered = deferred<void>(),
    response = deferred<Response>(),
    cancelling = deferred<void>(),
    closing = deferred<void>()
  const f = fixture({
    forward: () => {
      entered.resolve()
      return response.promise
    },
  })
  const controller = new AbortController()
  let settled = false
  const observed = f
    .receive(request({ signal: controller.signal }))
    .catch((cause: unknown) => {
      settled = true
      return cause
    })
  await entered.promise
  controller.abort()
  response.resolve(
    new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelling.resolve()
          return closing.promise
        },
      })
    )
  )
  await cancelling.promise
  expect(settled).toBe(false)
  closing.reject(new Error("private late cleanup defect"))
  expect(tags(await observed)).toEqual(["Interrupt", "Die"])
})
it("transfers a successful forwarded body to the caller instead of cancelling it at scope close", async () => {
  const cancel = vi.fn(async () => {})
  const f = fixture({
    forward: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("accepted"))
          },
          cancel,
        }),
        { status: 202, headers: { "x-forwarded": "original" } }
      ),
  })
  const response = await f.receive(request())
  expect(response.status).toBe(202)
  expect(response.headers.get("x-forwarded")).toBe("original")
  expect(cancel).not.toHaveBeenCalled()
  const reader = response.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("accepted")
  await reader.cancel()
  reader.releaseLock()
  expect(cancel).toHaveBeenCalledOnce()
})
